/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 128:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const fs = __nccwpck_require__(24);
const crypto = __nccwpck_require__(598);
const { spawnSync } = __nccwpck_require__(421);

function exportEnv(name, value) {
  const delimiter = `ghadelimiter_${crypto.randomUUID()}`;
  fs.appendFileSync(process.env.GITHUB_ENV, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  process.env[name] = String(value);
}

function addPath(value) {
  if (/[\r\n]/.test(value)) throw new Error('Invalid PATH entry');
  fs.appendFileSync(process.env.GITHUB_PATH, `${value}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) {
    if (options.allowFailure && result.error.code === 'ENOENT') return { status: 127, stdout: '', stderr: result.error.message };
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} failed (exit ${result.status}): ${(result.stderr || '').trim()}`);
  }
  return result;
}

function xargs(value) {
  let output = run('xargs', [], { input: value }).stdout;
  while (output.endsWith('\n')) output = output.slice(0, -1);
  return output;
}

module.exports = { exportEnv, addPath, run, xargs };

/***/ }),

/***/ 712:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const { exportEnv, run, xargs } = __nccwpck_require__(128);

function actorInfo() {
  const result = run('gh', ['api', `users/${process.env.GITHUB_ACTOR}`, '--jq', '{id:.id,node_id:.node_id}'], { allowFailure: true });
  if (result.status !== 0) return {};
  return JSON.parse(result.stdout || '{}');
}

function authorArgs(args, author) {
  if (author.id) args.push('--author-external-id', String(author.id));
  if (author.node_id) args.push('--author-external-global-id', String(author.node_id));
}

function createRelease() {
  const env = process.env;
  const provided = xargs(env.DC_INPUT_RELEASE_ID || '');
  if (provided) {
    exportEnv('DC_RELEASE_ID', provided);
    console.log(`Using provided dc-release-id '${provided}' and skipping release creation.`);
    return;
  }
  const withRelease = env.DC_INPUT_WITH_RELEASE === 'true';
  let name = env.DC_INPUT_NAME || '';
  let tagRaw = env.DC_INPUT_TAG || '';
  if (withRelease) {
    if ((!tagRaw || tagRaw === 'null') && (env.DC_REF || '').startsWith('refs/tags/')) tagRaw = env.DC_REF_NAME || '';
    if ((!name || name === 'null') && env.DC_REPO) name = env.DC_REPO;
    if (!name || name === 'null') throw new Error("Input 'name' is required when with-release is true.");
    if (!tagRaw || tagRaw === 'null') throw new Error("Input 'tag' is required when with-release is true (or trigger the workflow from a tag push).");
  }
  let tag = '';
  try { tag = xargs(tagRaw); } catch { tag = ''; }
  let scanName = withRelease ? `${name}-${tagRaw}` : name;
  if (!scanName || scanName === 'null') scanName = `${env.GITHUB_WORKFLOW || 'code-analysis-scan'}-${env.GITHUB_EVENT_NAME || 'manual'}`;
  scanName = scanName.replace(/\s+/g, '-').replace(/[/\\]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  if (!scanName) scanName = `code-analysis-${env.GITHUB_EVENT_NAME || 'manual'}`;
  const source = xargs((env.DC_INPUT_SOURCE || 'GITHUB_ACTION').toUpperCase()) || 'GITHUB_ACTION';
  if (!['GITHUB', 'GITHUB_ACTION'].includes(source)) throw new Error(`Invalid source: '${source}' (use GITHUB or GITHUB_ACTION).`);
  const args = ['release', 'create', '--vcs-repository-id', env.GITHUB_REPOSITORY_ID || '', '--repository-source', 'GITHUB', '--source', source, '--name', scanName, '--author', env.GITHUB_ACTOR || '', '--commit-sha', env.DC_COMMIT_SHA || '', '--source-branch', env.DC_REF_NAME || ''];
  if (withRelease) {
    let url, externalId, globalId, releasedAt, author;
    if (env.DC_INPUT_RELEASE_URL && env.DC_INPUT_RELEASE_NODE_ID && env.DC_INPUT_RELEASED_AT) {
      url = env.DC_INPUT_RELEASE_URL;
      globalId = env.DC_INPUT_RELEASE_NODE_ID.slice(0, 36);
      releasedAt = env.DC_INPUT_RELEASED_AT;
      author = actorInfo();
    } else {
      const result = run('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/releases/tags/${tag}`], { allowFailure: true });
      if (result.status !== 0) throw new Error(`Failed to fetch GitHub release metadata for tag '${tag}'.\ngh api error: ${result.stderr || result.stdout}`);
      const metadata = JSON.parse(result.stdout);
      if (!metadata.node_id || !metadata.html_url) throw new Error(`GitHub release metadata for tag '${tag}' is missing required fields (node_id, html_url).`);
      url = metadata.html_url;
      externalId = metadata.id;
      globalId = metadata.node_id.slice(0, 36);
      releasedAt = env.DC_INPUT_RELEASED_AT || metadata.published_at || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      author = metadata.author || {};
    }
    args.push('--release-type', 'RELEASED', '--status', 'RELEASED', '--tag', tag, '--release-url', url, '--external-global-id', globalId, '--released-at', releasedAt);
    if (externalId) args.push('--external-id', String(externalId));
    authorArgs(args, author);
  } else {
    const sha = env.GITHUB_SHA || '';
    const runId = env.GITHUB_RUN_ID || '0';
    args.push('--release-type', 'BUILD_ONLY', '--tag', sha.slice(0, 8), '--release-url', `https://github.com/${env.GITHUB_REPOSITORY}/commit/${sha}`, '--external-id', runId, '--external-global-id', `${sha.slice(0, 27)}-${runId.slice(0, 8)}`);
    authorArgs(args, actorInfo());
  }
  const result = run('smctl', args, { allowFailure: true });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  console.log(output.trimEnd());
  if (result.status !== 0) throw new Error(`smctl release create failed (exit ${result.status}).`);
  const match = /Release ID:[ \t\v\f\r]*([a-z0-9._-]+)/i.exec(output);
  const id = match?.[1];
  if (!id) throw new Error('Could not parse Release ID from smctl output.');
  exportEnv('DC_RELEASE_ID', String(id));
  console.log(`Release created: ${id}`);
}

module.exports = { createRelease };

/***/ }),

/***/ 491:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const fs = __nccwpck_require__(24);
const os = __nccwpck_require__(161);
const path = __nccwpck_require__(760);
const { exportEnv, run, xargs } = __nccwpck_require__(128);

function runLogged(command, args, log, options = {}) {
  const descriptor = fs.openSync(log, 'a');
  let result;
  try {
    result = run(command, args, { ...options, allowFailure: true, stdio: ['ignore', descriptor, descriptor] });
  } finally {
    fs.closeSync(descriptor);
  }
  if (result.status !== 0 && !options.ignoreFailure) throw new Error(`${command} failed (exit ${result.status}).`);
  return result;
}

function startScans() {
  const env = process.env;
  const work = path.join(env.RUNNER_TEMP, 'dc-bg-jobs');
  fs.mkdirSync(work, { recursive: true });
  exportEnv('DC_BG_WORK_DIR', work);
  const gitleaksLog = path.join(work, 'gitleaks.log');
  fs.writeFileSync(gitleaksLog, '');
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-scan-'));
  const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-archive-')), 'source.tar');
  try {
    runLogged('git', ['archive', '--output', archive, 'HEAD'], gitleaksLog, { cwd: env.GITHUB_WORKSPACE, env: { ...env, GIT_LFS_SKIP_SMUDGE: '1' } });
    runLogged('tar', ['-xf', archive, '-C', scanDir], gitleaksLog);
    runLogged('gitleaks', ['detect', '--source', scanDir, '--report-format', 'sarif', '--report-path', env.DC_GITLEAKS_SARIF_OUTPUT, '--no-banner', '--redact', '--no-git'], gitleaksLog, { cwd: env.GITHUB_WORKSPACE, ignoreFailure: true });
    if (!fs.existsSync(path.resolve(env.GITHUB_WORKSPACE, env.DC_GITLEAKS_SARIF_OUTPUT))) throw new Error('Gitleaks did not produce a SARIF report.');
    let findings = 0;
    try { findings = JSON.parse(fs.readFileSync(path.resolve(env.GITHUB_WORKSPACE, env.DC_GITLEAKS_SARIF_OUTPUT), 'utf8')).runs[0].results.length; } catch { findings = 0; }
    fs.appendFileSync(gitleaksLog, `Gitleaks findings: ${findings}\n`);
  } catch (error) {
    fs.appendFileSync(gitleaksLog, `${error.message}\n`);
    throw error;
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(archive), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(work, 'gitleaks.exit'), '0\n');
  const sbomLog = path.join(work, 'sbom.log');
  fs.writeFileSync(sbomLog, '');
  runLogged('smctl', ['sbom', 'generate', '--path', '.', '--output', env.DC_SBOM_OUTPUT, '--spec-version', env.DC_INPUT_SBOM_SPEC], sbomLog, { cwd: env.GITHUB_WORKSPACE });
  fs.writeFileSync(path.join(work, 'sbom.exit'), '0\n');
  console.log('Gitleaks and SBOM generation completed.');
}

function resolveLanguages() {
  const env = process.env;
  const priority = xargs((env.DC_INPUT_CODEQL_BUILD_MODE || 'none').toLowerCase());
  if (!['none', 'autobuild'].includes(priority)) throw new Error(`Invalid codeql-build-mode: '${priority}' (use none or autobuild).`);
  let languages = env.DC_INPUT_LANGUAGES || '';
  if (!languages) {
    const result = run('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/languages`, '--jq', 'keys[]'], { allowFailure: true });
    const mapping = { 'C#': 'csharp', Go: 'go', Java: 'java', Kotlin: 'java', JavaScript: 'javascript', TypeScript: 'javascript', Python: 'python', Ruby: 'ruby', Swift: 'swift' };
    const mapped = [];
    if (result.status === 0) {
      for (const language of result.stdout.split('\n')) {
        if (language === 'C' || language === 'C++') console.log(`Skipping ${language}: requires a manual build; not auto-scanned.`);
        const codeql = Object.hasOwn(mapping, language) ? mapping[language] : '';
        if (codeql && !mapped.includes(codeql)) mapped.push(codeql);
      }
    }
    languages = mapped.join(',');
    if (!languages) console.error('No CodeQL-supported languages detected; leaving empty for CodeQL autodetection fallback.');
  } else console.log(`Using languages override: ${languages}`);
  const list = languages.split(',').filter(Boolean);
  const hasBuild = list.some((language) => ['go', 'swift'].includes(language));
  const hasNone = list.some((language) => !['go', 'swift'].includes(language));
  let mode = priority;
  if (hasBuild && !hasNone) mode = 'autobuild';
  else if (hasNone && !hasBuild) mode = 'none';
  const output = list.filter((language) => mode === 'autobuild' ? ['go', 'swift'].includes(language) : !['go', 'swift'].includes(language)).join(',');
  exportEnv('DC_LANGUAGES', output);
  exportEnv('DC_CODEQL_BUILD_MODE', mode);
  console.log(`CodeQL build-mode: ${mode}; scanning: ${output || '<none matching this mode>'}`);
}

async function waitScans() {
  const work = process.env.DC_BG_WORK_DIR;
  const timeout = Number(process.env.DC_SCAN_TIMEOUT || '600');
  if (!Number.isInteger(timeout)) throw new Error('Invalid scan-timeout.');
  let elapsed = 0;
  while (!fs.existsSync(path.join(work, 'gitleaks.exit')) || !fs.existsSync(path.join(work, 'sbom.exit'))) {
    if (elapsed >= timeout) throw new Error(`Timeout: background jobs did not finish within ${timeout}s.`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    elapsed += 5;
  }
  let failed = false;
  for (const name of ['gitleaks', 'sbom']) {
    console.log(`----- ${name === 'sbom' ? 'sbom generate' : name} -----`);
    const log = path.join(work, `${name}.log`);
    if (fs.existsSync(log)) process.stdout.write(fs.readFileSync(log, 'utf8'));
    if (fs.readFileSync(path.join(work, `${name}.exit`), 'utf8').trim() !== '0') {
      console.error(`${name === 'sbom' ? 'SBOM generate' : 'Gitleaks scan'} failed.`);
      failed = true;
    }
  }
  if (failed) throw new Error('One or more scans failed.');
}

function sarifFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sarifFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.sarif')) files.push(file);
  }
  return files.sort();
}

function packageSarifs() {
  const env = process.env;
  const codeql = env.DC_SARIF_OUTPUT;
  const files = fs.existsSync(codeql) ? (fs.statSync(codeql).isDirectory() ? sarifFiles(codeql) : [codeql]) : [];
  if (files.length) {
    const result = run('zip', ['-j', env.DC_CODEQL_SCAN_ZIP, ...files]);
    process.stdout.write(result.stdout || '');
  } else console.error(`CodeQL SARIF (${codeql}) not found or empty; skipping CodeQL scan upload.`);
  if (fs.existsSync(env.DC_GITLEAKS_SARIF_OUTPUT)) {
    const result = run('zip', ['-j', env.DC_GITLEAKS_SCAN_ZIP, env.DC_GITLEAKS_SARIF_OUTPUT]);
    process.stdout.write(result.stdout || '');
  } else console.error(`Gitleaks SARIF (${env.DC_GITLEAKS_SARIF_OUTPUT}) not found; skipping its scan upload.`);
}

function upload() {
  const env = process.env;
  if (!env.DC_RELEASE_ID) throw new Error('No RELEASE_ID available; cannot upload.');
  const targets = [
    ['CodeQL SARIF', env.DC_CODEQL_SCAN_ZIP, ['scan', 'upload', '--file', env.DC_CODEQL_SCAN_ZIP, '--release-id', env.DC_RELEASE_ID, '--scanner-type', 'CODEQL', '--ref-branch', env.DC_REF_NAME || '', '--commit-sha', env.DC_COMMIT_SHA || '']],
    ['Gitleaks SARIF', env.DC_GITLEAKS_SCAN_ZIP, ['scan', 'upload', '--file', env.DC_GITLEAKS_SCAN_ZIP, '--release-id', env.DC_RELEASE_ID, '--scanner-type', 'GITLEAKS', '--ref-branch', env.DC_REF_NAME || '', '--commit-sha', env.DC_COMMIT_SHA || '']],
    ['SBOM', env.DC_SBOM_OUTPUT, ['sbom', 'upload', '--file', env.DC_SBOM_OUTPUT, '--release-id', env.DC_RELEASE_ID, '--commit-sha', env.DC_COMMIT_SHA || '', '--ref-branch', env.DC_REF_NAME || '']],
  ];
  let failed = false;
  for (const [name, file, args] of targets) {
    console.log(`--- Upload: ${name} ---`);
    if (!fs.existsSync(file)) { console.log(`No ${name} file found; skipping.`); continue; }
    const result = run('smctl', args, { allowFailure: true });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) { console.error(`${name} upload: FAILED`); failed = true; }
    else console.log(`${name} upload: OK`);
  }
  if (failed) throw new Error('One or more uploads failed.');
  console.log(`All scans and SBOM uploaded to release ${env.DC_RELEASE_ID}.`);
}

module.exports = { startScans, resolveLanguages, waitScans, packageSarifs, upload };

/***/ }),

/***/ 292:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const { exportEnv, xargs } = __nccwpck_require__(128);

function rejectControls(value, name) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}: contains control characters.`);
}

function normalizeInputs() {
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
  const languages = (env.RAW_LANGUAGES || '').toLowerCase().replace(/[\t\n\v\f\r ]/g, '');
  const tokens = languages.split(',');
  if (tokens.at(-1) === '') tokens.pop();
  if (languages && tokens.some((language) => !/^[a-z-]{1,32}$/.test(language))) {
    throw new Error('Invalid language identifier (use [a-z-]{1,32}, comma-separated).');
  }
  const spec = xargs(env.RAW_SBOM_SPEC || '1.6');
  if (!['1.5', '1.6'].includes(spec)) throw new Error(`Invalid sbom-spec-version: '${spec}' (use 1.5 or 1.6).`);
  let cdn = xargs(env.RAW_CDN || '');
  rejectControls(cdn, 'digicert-cdn');
  if (!cdn.startsWith('https://')) throw new Error(`Invalid digicert-cdn: '${cdn}' must use HTTPS.`);
  cdn = cdn.replace(/\/$/, '');

  exportEnv('DC_INPUT_HOST', host);
  exportEnv('DC_INPUT_WITH_RELEASE', withRelease);
  exportEnv('DC_INPUT_SBOM_SPEC', spec);
  exportEnv('DC_INPUT_CDN', cdn);
  for (const [field] of fields) exportEnv(`DC_INPUT_${field}`, env[`RAW_${field}`] || '');
  exportEnv('DC_INPUT_LANGUAGES', languages);
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
    DC_GITLEAKS_VERSION: env.DC_GITLEAKS_VERSION_INPUT || '8.18.4',
    DC_CODEQL_TOOLS_VERSION: env.DC_CODEQL_TOOLS_VERSION_INPUT || '',
  };
  for (const [name, value] of Object.entries(values)) exportEnv(name, value);
}

module.exports = { normalizeInputs, exportAuth, resolveContext };

/***/ }),

/***/ 606:
/***/ ((module, __unused_webpack_exports, __nccwpck_require__) => {



const fs = __nccwpck_require__(24);
const os = __nccwpck_require__(161);
const path = __nccwpck_require__(760);
const crypto = __nccwpck_require__(598);
const { exportEnv, addPath, run, xargs } = __nccwpck_require__(128);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetch(url, destination, maxTime) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = run('curl', ['-fsSL', '--connect-timeout', '10', '--max-time', String(maxTime), '-o', destination, url], { allowFailure: true });
    if (result.status === 0) return;
    if (attempt === 3) throw new Error(`Failed to download ${url} after 3 attempts.`);
    const seconds = 2 ** attempt;
    console.error(`Download of ${url} failed (attempt ${attempt}/3); retrying in ${seconds}s...`);
    await delay(seconds * 1000);
  }
}

function checksum(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function cacheKeys() {
  const env = process.env;
  const cache = env.RUNNER_TOOL_CACHE || `${env.RUNNER_TEMP || '/tmp'}/tool-cache`;
  const cacheVersion = env.DC_CACHE_VERSION || '0.0.0-0';
  let sha = '';
  let version = `0.0.0-${cacheVersion}`;
  if (xargs((env.DC_USE_CHECKSUM || 'true').toLowerCase()) === 'true') {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sha-'));
    try {
      const file = path.join(temp, 'smctl.sha256');
      await fetch(`${env.DC_INPUT_CDN}/smctl.sha256`, file, 60);
      const candidate = (fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0] || '').toLowerCase();
      if (/^[a-f0-9]{64}$/.test(candidate)) {
        sha = candidate;
        version = `0.0.0-${sha}`;
      } else {
        console.error('Unexpected smctl.sha256 content; falling back to cache-version.');
      }
    } catch (error) {
      console.error(`Could not fetch smctl.sha256; falling back to cache-version. ${error.message}`);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  const values = {
    DC_SMCTL_BIN_DIR: `${cache}/smctl/${version}/x64`,
    DC_GITLEAKS_BIN_DIR: `${cache}/gitleaks/${env.DC_GITLEAKS_VERSION}/x64`,
    DC_SMCTL_TOOL_CACHE_ROOT: `${cache}/smctl`,
    DC_GITLEAKS_TOOL_CACHE_ROOT: `${cache}/gitleaks`,
    DC_SMCTL_SHA256: sha,
    SMCTL_CACHE_KEY: `smctl-${cacheVersion}-linux-x64`,
    GITLEAKS_CACHE_KEY: `gitleaks-${env.DC_GITLEAKS_VERSION}-linux-x64`,
  };
  for (const [name, value] of Object.entries(values)) exportEnv(name, value);
}

function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

async function downloadSmctl() {
  const env = process.env;
  const file = path.join(env.DC_SMCTL_BIN_DIR, 'smctl');
  if (executable(file)) return console.log(`smctl found in tool cache @ ${env.DC_SMCTL_BIN_DIR}`);
  fs.mkdirSync(env.DC_SMCTL_BIN_DIR, { recursive: true });
  console.log(`Downloading smctl from ${env.DC_INPUT_CDN}/smctl`);
  await fetch(`${env.DC_INPUT_CDN}/smctl`, file, 120);
  if (env.DC_SMCTL_SHA256) {
    const actual = checksum(file);
    if (actual !== env.DC_SMCTL_SHA256) throw new Error(`SECURITY ERROR: smctl checksum mismatch.\nExpected: ${env.DC_SMCTL_SHA256}\nActual:   ${actual}`);
    console.log('smctl checksum verified.');
  } else console.error('WARNING: smctl checksum unavailable; skipping verification.');
  fs.chmodSync(file, 0o755);
}

function downloadGitleaks() {
  const env = process.env;
  const file = path.join(env.DC_GITLEAKS_BIN_DIR, 'gitleaks');
  if (executable(file)) return console.log(`gitleaks ${env.DC_GITLEAKS_VERSION} found in tool cache @ ${env.DC_GITLEAKS_BIN_DIR}`);
  const version = env.DC_GITLEAKS_VERSION;
  const tarball = `gitleaks_${version}_linux_x64.tar.gz`;
  const base = `https://github.com/gitleaks/gitleaks/releases/download/v${version}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-gitleaks-'));
  try {
    run('curl', ['-fsSL', '-o', tarball, `${base}/${tarball}`], { cwd: temp });
    run('curl', ['-fsSL', '-o', 'checksums.txt', `${base}/gitleaks_${version}_checksums.txt`], { cwd: temp });
    const entries = fs.readFileSync(path.join(temp, 'checksums.txt'), 'utf8').split('\n').filter((line) => line.includes(tarball));
    if (!entries.length) throw new Error('Gitleaks checksum not found.');
    run('sha256sum', ['-c', '-'], { cwd: temp, input: `${entries.join('\n')}\n` });
    run('tar', ['-xzf', tarball], { cwd: temp });
    fs.chmodSync(path.join(temp, 'gitleaks'), 0o755);
    fs.mkdirSync(env.DC_GITLEAKS_BIN_DIR, { recursive: true });
    fs.copyFileSync(path.join(temp, 'gitleaks'), file);
    fs.chmodSync(file, 0o755);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function addTools() {
  for (const [directory, name, args] of [[process.env.DC_SMCTL_BIN_DIR, 'smctl', ['--version']], [process.env.DC_GITLEAKS_BIN_DIR, 'gitleaks', ['version']]]) {
    addPath(directory);
    const file = path.join(directory, name);
    console.log(`${name}: ${file}`);
    const result = run(file, args, { allowFailure: true });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) console.log(`${name} version check failed (non-fatal)`);
  }
}

module.exports = { cacheKeys, downloadSmctl, downloadGitleaks, addTools };

/***/ }),

/***/ 421:
/***/ ((module) => {

module.exports = require("node:child_process");

/***/ }),

/***/ 598:
/***/ ((module) => {

module.exports = require("node:crypto");

/***/ }),

/***/ 24:
/***/ ((module) => {

module.exports = require("node:fs");

/***/ }),

/***/ 161:
/***/ ((module) => {

module.exports = require("node:os");

/***/ }),

/***/ 760:
/***/ ((module) => {

module.exports = require("node:path");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};


const setup = __nccwpck_require__(292);
const tools = __nccwpck_require__(606);
const release = __nccwpck_require__(712);
const scans = __nccwpck_require__(491);

function guardTrigger() {
  if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
    throw new Error('This action must not run on pull_request_target due to secret exposure risk.\nUse pull_request (or push/workflow_dispatch) instead.');
  }
}

const steps = {
  'guard-trigger': guardTrigger,
  'normalize-inputs': setup.normalizeInputs,
  'export-auth': setup.exportAuth,
  'resolve-context': setup.resolveContext,
  'cache-keys': tools.cacheKeys,
  'download-smctl': tools.downloadSmctl,
  'download-gitleaks': tools.downloadGitleaks,
  'add-tools': tools.addTools,
  'create-release': release.createRelease,
  'start-scans': scans.startScans,
  'resolve-languages': scans.resolveLanguages,
  'wait-scans': scans.waitScans,
  'package-sarifs': scans.packageSarifs,
  'upload': scans.upload,
};

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Node.js 24 or newer is required on the runner.');
  }
  const step = process.argv[2];
  if (!Object.hasOwn(steps, step)) {
    throw new Error(`Unknown action step: ${step}`);
  }
  await steps[step]();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = __webpack_exports__;
/******/ })()
;