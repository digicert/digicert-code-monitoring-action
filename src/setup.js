'use strict';

const { exportEnv, xargs } = require('./common');
const { parseExternal, downloadExternal } = require('./external');

function rejectControls(value, name) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}: contains control characters.`);
}

// These values reach download URLs, cache keys and tool-cache paths, so allow only a safe charset.
function safeToken(value, pattern, message) {
  rejectControls(value, 'input');
  if (!pattern.test(value)) throw new Error(message);
  return value;
}

function toolInputs(env) {
  const useChecksum = xargs((env.RAW_USE_CHECKSUM || 'true').toLowerCase()) || 'true';
  if (!['true', 'false'].includes(useChecksum)) throw new Error(`Invalid use-binary-sha256-checksum: '${useChecksum}' (use true|false).`);
  const cacheVersion = safeToken(env.RAW_CACHE_VERSION || '0.0.0-0', /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Invalid cache-version: use 1-64 characters from [A-Za-z0-9._-], starting with an alphanumeric.');
  const gitleaksVersion = safeToken(env.RAW_GITLEAKS_VERSION || '8.18.4', /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/, 'Invalid gitleaks-version: use a plain X.Y.Z release version (e.g. 8.18.4).');
  const codeqlTools = env.RAW_CODEQL_TOOLS_VERSION ? safeToken(env.RAW_CODEQL_TOOLS_VERSION, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Invalid codeql-tools-version: use a version such as 2.17.6 (1-64 characters from [A-Za-z0-9._-]).') : '';
  return { useChecksum, cacheVersion, gitleaksVersion, codeqlTools, scanTimeout: scanTimeoutInput(env) };
}

// Seconds; capped at GitHub's maximum job duration so the value is always a sane time limit.
function scanTimeoutInput(env) {
  const value = (env.RAW_SCAN_TIMEOUT || '600').trim();
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 21600) throw new Error('Invalid scan-timeout: use a whole number of seconds from 1 to 21600.');
  return value;
}

function artifactInputs(env) {
  const skipSbom = (env.RAW_SKIP_SBOM || 'false').trim().toLowerCase();
  const skipSarif = (env.RAW_SKIP_SARIF || 'false').trim().toLowerCase();
  if (!['true', 'false'].includes(skipSbom)) throw new Error("Invalid skip-sbom input (use true|false).");
  if (!['true', 'false'].includes(skipSarif)) throw new Error("Invalid skip-sarif input (use true|false).");
  const entries = parseExternal(env.RAW_EXTERNAL_PATHS, skipSbom === 'true', skipSarif === 'true');
  return { skipSbom, skipSarif, entries };
}

async function normalizeInputs() {
  const env = process.env;
  let host = xargs(env.RAW_HOST || '');
  if (!host) throw new Error("Input 'host' is required.");
  rejectControls(host, 'host');
  if (!host.startsWith('https://')) throw new Error(`Invalid host: '${host}' must use HTTPS.`);
  host = host.replace(/\/$/, '');

  const withRelease = xargs((env.RAW_WITH_RELEASE || 'false').toLowerCase()) || 'false';
  if (!['true', 'false'].includes(withRelease)) throw new Error(`Invalid with-release input: '${withRelease}' (use true|false)`);
  if (!env.RAW_API_KEY) throw new Error("Input 'api-key' is required.");
  rejectControls(env.RAW_API_KEY, 'api-key');

  const fields = [
    ['NAME', 'name'], ['TAG', 'tag'], ['RELEASE_ID', 'dc-release-id'],
    ['COMMIT_SHA', 'commit-sha'], ['BRANCH', 'branch'],
  ];
  for (const [field, name] of fields) rejectControls(env[`RAW_${field}`] || '', name);
  const { skipSbom, skipSarif, entries } = artifactInputs(env);
  const hasCodeql = entries.some((entry) => entry.type === 'CODEQL');
  const hasGitleaks = entries.some((entry) => entry.type === 'GITLEAKS');
  const hasSbom = entries.some((entry) => entry.type === 'SBOM');
  const languages = skipSarif === 'true' || hasCodeql ? '' : (env.RAW_LANGUAGES || '').toLowerCase().replace(/[\t\n\v\f\r ]/g, '');
  const tokens = languages.split(',');
  if (tokens.at(-1) === '') tokens.pop();
  if (languages && tokens.some((language) => !/^[a-z-]{1,32}$/.test(language))) {
    throw new Error('Invalid language identifier (use [a-z-]{1,32}, comma-separated).');
  }
  const spec = skipSbom === 'true' || hasSbom ? '1.6' : xargs(env.RAW_SBOM_SPEC || '1.6');
  if (!['1.5', '1.6'].includes(spec)) throw new Error(`Invalid sbom-spec-version: '${spec}' (use 1.5 or 1.6).`);
  let cdn = xargs(env.RAW_CDN || '');
  rejectControls(cdn, 'digicert-cdn');
  if (!cdn.startsWith('https://')) throw new Error(`Invalid digicert-cdn: '${cdn}' must use HTTPS.`);
  cdn = cdn.replace(/\/$/, '');
  const tools = toolInputs(env);
  const externalFiles = await downloadExternal(entries, env.RUNNER_TEMP);

  exportEnv('DC_INPUT_HOST', host);
  exportEnv('DC_INPUT_WITH_RELEASE', withRelease);
  exportEnv('DC_INPUT_SBOM_SPEC', spec);
  exportEnv('DC_INPUT_CDN', cdn);
  exportEnv('DC_INPUT_USE_CHECKSUM', tools.useChecksum);
  exportEnv('DC_INPUT_CACHE_VERSION', tools.cacheVersion);
  exportEnv('DC_GITLEAKS_VERSION', tools.gitleaksVersion);
  exportEnv('DC_CODEQL_TOOLS_VERSION', tools.codeqlTools);
  exportEnv('DC_INPUT_SCAN_TIMEOUT', tools.scanTimeout);
  for (const [field] of fields) exportEnv(`DC_INPUT_${field}`, env[`RAW_${field}`] || '');
  exportEnv('DC_INPUT_LANGUAGES', languages);
  exportEnv('DC_SKIP_SBOM', skipSbom);
  exportEnv('DC_SKIP_SARIF', skipSarif);
  // An external file of a type replaces its generation; skip disables it entirely.
  exportEnv('DC_RUN_CODEQL', String(skipSarif !== 'true' && !hasCodeql));
  exportEnv('DC_RUN_GITLEAKS', String(skipSarif !== 'true' && !hasGitleaks));
  exportEnv('DC_RUN_SBOM', String(skipSbom !== 'true' && !hasSbom));
  exportEnv('DC_EXTERNAL_ARTIFACTS', JSON.stringify(externalFiles));
}

function exportAuth() {
  exportEnv('SM_HOST', process.env.DC_INPUT_HOST);
  exportEnv('SM_API_KEY', process.env.DC_INPUT_API_KEY);
}

function resolveContext() {
  const env = process.env;
  if (!env.GITHUB_REPOSITORY_OWNER || !env.GITHUB_REPOSITORY) throw new Error('Missing GitHub repository context (GITHUB_REPOSITORY_OWNER/GITHUB_REPOSITORY).');
  const repo = env.GITHUB_REPOSITORY.includes('/') ? env.GITHUB_REPOSITORY.slice(env.GITHUB_REPOSITORY.indexOf('/') + 1) : env.GITHUB_REPOSITORY;
  if (!repo || repo === env.GITHUB_REPOSITORY) throw new Error(`Could not parse repo name from GITHUB_REPOSITORY=${env.GITHUB_REPOSITORY}`);
  const refName = xargs(env.DC_INPUT_BRANCH || '') || (env.GITHUB_EVENT_NAME === 'pull_request' ? env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || '' : env.GITHUB_REF_NAME || '');
  const values = {
    DC_OWNER: env.GITHUB_REPOSITORY_OWNER,
    DC_REPO: repo,
    DC_COMMIT_SHA: xargs(env.DC_INPUT_COMMIT_SHA || '') || env.GITHUB_SHA || '',
    DC_REF: env.GITHUB_REF || '',
    DC_REF_NAME: refName,
    DC_SARIF_OUTPUT: `${env.GITHUB_WORKSPACE}/codeql.sarif`,
    DC_GITLEAKS_SARIF_OUTPUT: 'gitleaks.sarif',
    DC_CODEQL_SCAN_ZIP: 'codeql-scan.zip',
    DC_GITLEAKS_SCAN_ZIP: 'gitleaks-scan.zip',
    DC_SBOM_OUTPUT: 'sbom.cdx.json',
  };
  for (const [name, value] of Object.entries(values)) exportEnv(name, value);
}

module.exports = { normalizeInputs, exportAuth, resolveContext };