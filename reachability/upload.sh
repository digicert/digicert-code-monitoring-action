#!/usr/bin/env bash
# Extracts a function-level call graph from finalized CodeQL databases and uploads it to
# Software Trust Manager so vulnerabilities can be classified as reachable or not.
#
# Required env: DC_CODEQL_PATH (codeql CLI), DC_LANGUAGES, DC_RELEASE_ID, SM_HOST, SM_API_KEY
# Optional env: DC_COMMIT_SHA, DC_SBOM_OUTPUT, DC_REACHABILITY_DIR, DC_CODEQL_DB_DIR,
#               DC_REACHABILITY_DRY_RUN=true (build JSON only, skip upload)
set -euo pipefail

QUERY_DIR="${DC_REACHABILITY_DIR:-$(cd "$(dirname "$0")" && pwd)}"
DB_ROOT="${DC_CODEQL_DB_DIR:-${RUNNER_TEMP:-/tmp}/codeql_databases}"
CODEQL="${DC_CODEQL_PATH:-codeql}"
SBOM_FILE="${DC_SBOM_OUTPUT:-sbom.cdx.json}"
REPO_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! command -v "$CODEQL" >/dev/null 2>&1 && [ ! -x "$CODEQL" ]; then
  echo "CodeQL CLI not found; skipping reachability." >&2
  exit 0
fi

case "${DC_RELEASE_ID:-}" in
  ''|*[!A-Za-z0-9-]*) echo "Invalid or missing DC_RELEASE_ID; skipping reachability." >&2; exit 0 ;;
esac

# SBOM dependency graph (root ref + ref->dependsOn) lets STM resolve transitive paths.
SBOM_JSON='{"root":null,"deps":[]}'
if [ -f "$SBOM_FILE" ]; then
  SBOM_JSON="$(jq -c '{root: (.metadata.component["bom-ref"] // null),
    deps: [(.dependencies // [])[] | {ref: .ref, depends_on: (.dependsOn // [])}]}' "$SBOM_FILE" 2>/dev/null \
    || echo '{"root":null,"deps":[]}')"
fi
printf '%s' "$SBOM_JSON" > "$WORK/sbom.json"

if [ "${DC_REACHABILITY_DRY_RUN:-false}" != "true" ]; then
  if [ -z "${SM_HOST:-}" ] || [ -z "${SM_API_KEY:-}" ]; then
    echo "SM_HOST/SM_API_KEY not set; skipping reachability upload." >&2
    exit 0
  fi
  # Keep the API key out of the process list.
  HEADER_FILE="$WORK/auth.hdr"
  ( umask 077; printf 'x-api-key: %s\n' "$SM_API_KEY" > "$HEADER_FILE" )
fi

run_query() {
  local db="$1" query="$2" out="$3"
  if ! "$CODEQL" query run --database="$db" --output="$WORK/q.bqrs" "$query" >"$WORK/q.log" 2>&1; then
    tail -20 "$WORK/q.log" >&2
    return 1
  fi
  "$CODEQL" bqrs decode --format=json --output="$out" "$WORK/q.bqrs"
}

IFS=',' read -ra LANGS <<< "${DC_LANGUAGES:-}"
for raw_lang in "${LANGS[@]}"; do
  lang="${raw_lang%%-*}"   # javascript-typescript -> javascript
  [ -d "$QUERY_DIR/$lang" ] || { echo "Reachability: '$lang' not supported yet; skipping."; continue; }
  db="$DB_ROOT/$lang"
  [ -d "$db" ] || { echo "Reachability: no CodeQL database at $db; skipping $lang." >&2; continue; }

  echo "--- Reachability: $lang ---"
  if ! run_query "$db" "$QUERY_DIR/$lang/functions.ql" "$WORK/functions.json" \
    || ! run_query "$db" "$QUERY_DIR/$lang/edges.ql" "$WORK/edges.json" \
    || ! run_query "$db" "$QUERY_DIR/$lang/external-calls.ql" "$WORK/external.json"; then
    echo "Reachability: query evaluation failed for $lang; skipping." >&2
    continue
  fi

  out="$WORK/reachability-$lang.json"
  jq -n -c \
    --arg lang "$lang" --arg sha "${DC_COMMIT_SHA:-${GITHUB_SHA:-}}" --arg repo "$REPO_URL" \
    --slurpfile f "$WORK/functions.json" --slurpfile e "$WORK/edges.json" \
    --slurpfile x "$WORK/external.json" --slurpfile s "$WORK/sbom.json" \
    '{schema_version: 1, language: $lang, commit_sha: $sha, repo_url: $repo,
      functions: $f[0]["#select"].tuples, edges: $e[0]["#select"].tuples,
      external_calls: $x[0]["#select"].tuples,
      sbom_root_ref: $s[0].root, sbom_dependencies: $s[0].deps}' > "$out"
  gzip -9 -c "$out" > "$out.gz"
  echo "Reachability: $(jq '.functions|length' "$out") functions, $(jq '.edges|length' "$out") edges, $(jq '.external_calls|length' "$out") external calls ($(wc -c < "$out.gz" | tr -d ' ') bytes gz)"

  if [ "${DC_REACHABILITY_DRY_RUN:-false}" = "true" ]; then
    cp "$out" "${DC_REACHABILITY_OUT_DIR:-.}/reachability-$lang.json"
    continue
  fi

  code="$(curl -sS -o "$WORK/resp.txt" -w '%{http_code}' --max-time 120 \
    -H @"$HEADER_FILE" \
    -F "file=@$out.gz;type=application/gzip" \
    "${SM_HOST}/signingmanager/api/v1/external-releases/${DC_RELEASE_ID}/reachability" || echo 000)"
  if [ "${code:0:1}" = "2" ]; then
    echo "Reachability upload ($lang): OK"
  else
    echo "Reachability upload ($lang): FAILED (HTTP $code)" >&2
    head -c 500 "$WORK/resp.txt" >&2 || true
    echo >&2
  fi
done
exit 0
