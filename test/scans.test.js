'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { child } = require('../src/common');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-scans-'));
  const workspace = path.join(root, 'workspace');
  const bin = path.join(root, 'bin');
  const envFile = path.join(root, 'env');
  const log = path.join(root, 'calls');
  fs.mkdirSync(workspace);
  fs.mkdirSync(bin);
  fs.writeFileSync(envFile, '');
  for (const command of ['gh', 'gitleaks', 'smctl']) {
    const script = `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.CALL_LOG, JSON.stringify([${JSON.stringify(command)}, ...args]) + '\\n');\nif (${JSON.stringify(command)} === 'gh') console.log(process.env.LANGUAGES || '');\nif (${JSON.stringify(command)} === 'gitleaks' && process.env.LARGE_SCAN_LOG) process.stdout.write('x'.repeat(2 * 1024 * 1024));\nif (${JSON.stringify(command)} === 'gitleaks') fs.writeFileSync(args[args.indexOf('--report-path') + 1], JSON.stringify({runs:[{results:[]}]}));\nif (${JSON.stringify(command)} === 'smctl' && args[1] === 'generate' && process.env.SLEEP_GENERATE) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SLEEP_GENERATE) * 1000);\nif (${JSON.stringify(command)} === 'smctl' && args[1] === 'generate' && process.env.FAIL_GENERATE) { fs.writeFileSync(args[args.indexOf('--output') + 1], 'partial'); process.exit(1); }\nif (${JSON.stringify(command)} === 'smctl' && args[1] === 'generate') fs.writeFileSync(args[args.indexOf('--output') + 1], '{}');\nif (${JSON.stringify(command)} === 'smctl' && args[1] === 'upload' && args.includes('CODEQL') && process.env.FAIL_CODEQL) process.exit(1);\n`;
    fs.writeFileSync(path.join(bin, command), script, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ENV: envFile, CALL_LOG: log, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: root, DC_INPUT_SBOM_SPEC: '1.6', DC_GITLEAKS_SARIF_OUTPUT: 'gitleaks.sarif', DC_CODEQL_SCAN_ZIP: 'codeql.zip', DC_GITLEAKS_SCAN_ZIP: 'gitleaks.zip', DC_SBOM_OUTPUT: 'sbom.json', DC_SARIF_OUTPUT: path.join(workspace, 'codeql.sarif'), DC_RELEASE_ID: 'release-id', DC_REF_NAME: 'main', DC_COMMIT_SHA: 'commit', GITHUB_REPOSITORY: 'owner/repo', DC_RUN_CODEQL: 'true', DC_RUN_GITLEAKS: 'true', DC_RUN_SBOM: 'true' };
  return {
    root, workspace, env,
    execute(step, overrides = {}) {
      const entry = path.join(__dirname, `../${process.env.NODE_ACTION_ENTRY === 'dist' ? 'dist' : 'src'}/index.js`);
      const result = spawnSync(process.execPath, [entry, step], { env: { ...env, ...overrides }, cwd: workspace, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      return { ...result, exported: fs.readFileSync(envFile, 'utf8'), calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const off = { DC_RUN_CODEQL: 'false', DC_RUN_GITLEAKS: 'false', DC_RUN_SBOM: 'false' };

function initializeGit(workspace) {
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test'], ['add', 'tracked.txt'], ['commit', '-qm', 'test']]) {
    if (args[0] === 'add') fs.writeFileSync(child(workspace, 'tracked.txt'), 'content');
    const git = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
}

test('maps detected languages and selects the requested mode for mixed repositories', () => {
  const data = fixture();
  try {
    const result = data.execute('resolve-languages', { LANGUAGES: 'JavaScript\nTypeScript\nGo\nPython', DC_INPUT_CODEQL_BUILD_MODE: 'autobuild' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.exported, /DC_LANGUAGES<<[^\n]+\ngo\n/);
    assert.match(result.exported, /DC_CODEQL_BUILD_MODE<<[^\n]+\nautobuild\n/);
  } finally { data.cleanup(); }
});

test('creates scan artifacts sequentially and verifies the exit markers', () => {
  const data = fixture();
  try {
    initializeGit(data.workspace);
    const result = data.execute('start-scans', { LARGE_SCAN_LOG: 'true' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map((call) => call[0]), ['gitleaks', 'smctl']);
    assert.ok(fs.existsSync(path.join(data.workspace, 'gitleaks.sarif')));
    assert.ok(fs.existsSync(path.join(data.workspace, 'sbom.json')));
    assert.ok(fs.statSync(path.join(data.root, 'dc-bg-jobs', 'gitleaks.log')).size > 2 * 1024 * 1024);
    const verified = data.execute('verify-scans', { DC_BG_WORK_DIR: path.join(data.root, 'dc-bg-jobs') });
    assert.equal(verified.status, 0, verified.stderr);
  } finally { data.cleanup(); }
});

test('runs Gitleaks while SBOM is skipped', () => {
  const data = fixture();
  try {
    initializeGit(data.workspace);
    const result = data.execute('start-scans', { DC_SKIP_SBOM: 'true', DC_RUN_SBOM: 'false' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map((call) => call[0]), ['gitleaks']);
    assert.equal(data.execute('verify-scans', { DC_RUN_SBOM: 'false', DC_BG_WORK_DIR: path.join(data.root, 'dc-bg-jobs') }).status, 0);
  } finally { data.cleanup(); }
});

test('runs Gitleaks when only CodeQL is supplied externally', () => {
  const data = fixture();
  try {
    initializeGit(data.workspace);
    const result = data.execute('start-scans', { DC_RUN_CODEQL: 'false', DC_RUN_SBOM: 'false' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map((call) => call[0]), ['gitleaks']);
  } finally { data.cleanup(); }
});

test('runs Gitleaks with exit-code 0, removes a stale report, and fails on a real scanner error', () => {
  const data = fixture();
  try {
    initializeGit(data.workspace);
    const stale = path.join(data.workspace, 'gitleaks.sarif');
    fs.writeFileSync(stale, 'stale report');
    const ok = data.execute('start-scans', { DC_RUN_SBOM: 'false' });
    assert.equal(ok.status, 0, ok.stderr);
    const args = ok.calls.find((call) => call[0] === 'gitleaks');
    assert.equal(args[args.indexOf('--exit-code') + 1], '0');
    assert.notEqual(fs.readFileSync(stale, 'utf8'), 'stale report');
    const bin = path.join(data.root, 'bin', 'gitleaks');
    fs.writeFileSync(bin, `#!${process.execPath}\nprocess.exit(2);\n`, { mode: 0o755 });
    fs.rmSync(stale);
    const failed = data.execute('start-scans', { DC_RUN_SBOM: 'false' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /gitleaks failed \(exit 2\)/);
    assert.equal(fs.existsSync(stale), false);
  } finally { data.cleanup(); }
});

test('fails when repository languages cannot be detected and explains how to proceed', () => {
  const data = fixture();
  try {
    fs.writeFileSync(path.join(data.root, 'bin', 'gh'), `#!${process.execPath}\nconsole.error('HTTP 403: forbidden');\nprocess.exit(1);\n`, { mode: 0o755 });
    const result = data.execute('resolve-languages');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Failed to detect repository languages/);
    assert.match(result.stderr, /HTTP 403/);
    assert.match(result.stderr, /set the 'languages' input explicitly/);
    assert.equal(result.exported, '');
    const explicit = data.execute('resolve-languages', { DC_INPUT_LANGUAGES: 'java' });
    assert.equal(explicit.status, 0, explicit.stderr);
  } finally { data.cleanup(); }
});

test('says CodeQL will be skipped when no supported language is detected', () => {
  for (const languages of ['', 'Shell\nMakefile']) {
    const data = fixture();
    try {
      const result = data.execute('resolve-languages', { LANGUAGES: languages });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /CodeQL analysis will be skipped/);
      assert.match(result.exported, /DC_LANGUAGES<<[^\n]+\n\n/);
    } finally { data.cleanup(); }
  }
});

test('stops a scan that exceeds scan-timeout and removes its partial output', () => {
  const data = fixture();
  try {
    const started = Date.now();
    const result = data.execute('start-scans', { DC_RUN_GITLEAKS: 'false', DC_INPUT_SCAN_TIMEOUT: '1', SLEEP_GENERATE: '20' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /smctl did not finish within the scan-timeout of 1s/);
    assert.ok(Date.now() - started < 15000, 'the scan was killed, not waited for');
    assert.equal(fs.existsSync(path.join(data.workspace, 'sbom.json')), false);
    assert.equal(fs.existsSync(path.join(data.root, 'dc-bg-jobs', 'sbom.exit')), false);
  } finally { data.cleanup(); }
});

test('removes a stale SBOM before generating and never uploads it after a failed generation', () => {
  const data = fixture();
  try {
    const sbom = path.join(data.workspace, 'sbom.json');
    fs.writeFileSync(sbom, 'committed or stale SBOM');
    const failed = data.execute('start-scans', { DC_RUN_GITLEAKS: 'false', FAIL_GENERATE: '1' });
    assert.equal(failed.status, 1);
    assert.equal(fs.existsSync(sbom), false, 'stale and partial SBOM removed');
    const upload = data.execute('upload', { DC_RUN_CODEQL: 'false', DC_RUN_GITLEAKS: 'false' });
    assert.equal(upload.status, 0, upload.stderr);
    assert.deepEqual(upload.calls.filter((call) => call[1] === 'sbom' && call[2] === 'upload'), []);
    assert.match(upload.stdout, /No SBOM file found; skipping/);
    fs.writeFileSync(sbom, 'stale again');
    const ok = data.execute('start-scans', { DC_RUN_GITLEAKS: 'false' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.readFileSync(sbom, 'utf8'), '{}');
  } finally { data.cleanup(); }
});

test('removes a stale SBOM even when an earlier scan fails before SBOM generation starts', () => {
  const data = fixture();
  try {
    initializeGit(data.workspace);
    fs.writeFileSync(path.join(data.root, 'bin', 'gitleaks'), `#!${process.execPath}\nprocess.exit(2);\n`, { mode: 0o755 });
    const sbom = path.join(data.workspace, 'sbom.json');
    fs.writeFileSync(sbom, 'committed SBOM');
    const result = data.execute('start-scans');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gitleaks failed/);
    assert.equal(fs.existsSync(sbom), false);
    const upload = data.execute('upload', { DC_RUN_CODEQL: 'false', DC_RUN_GITLEAKS: 'false' });
    assert.equal(upload.calls.filter((call) => call[1] === 'sbom' && call[2] === 'upload').length, 0);
  } finally { data.cleanup(); }
});

test('removes a partial Gitleaks report when the scan times out', () => {
  const data = fixture();
  try {
    initializeGit(data.workspace);
    fs.writeFileSync(path.join(data.root, 'bin', 'gitleaks'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv[process.argv.indexOf('--report-path') + 1], 'partial');\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);\n`, { mode: 0o755 });
    const result = data.execute('start-scans', { DC_RUN_SBOM: 'false', DC_INPUT_SCAN_TIMEOUT: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gitleaks did not finish within the scan-timeout of 1s/);
    assert.equal(fs.existsSync(path.join(data.workspace, 'gitleaks.sarif')), false);
  } finally { data.cleanup(); }
});

test('reports scans that did not finish and scans that failed, even when logs are missing', () => {
  const data = fixture();
  try {
    const missing = data.execute('verify-scans', { DC_BG_WORK_DIR: data.root });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Gitleaks scan did not complete/);
    assert.match(missing.stderr, /SBOM generate did not complete/);
    fs.writeFileSync(path.join(data.root, 'gitleaks.exit'), '1\n');
    fs.writeFileSync(path.join(data.root, 'sbom.exit'), '0\n');
    const failed = data.execute('verify-scans', { DC_BG_WORK_DIR: data.root });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Gitleaks scan failed/);
    assert.doesNotMatch(failed.stderr, /SBOM generate/);
  } finally { data.cleanup(); }
});

test('skips Gitleaks when SARIF is skipped or provided externally', () => {
  for (const overrides of [{ DC_SKIP_SARIF: 'true', DC_RUN_CODEQL: 'false', DC_RUN_GITLEAKS: 'false' }, { DC_RUN_GITLEAKS: 'false' }]) {
    const data = fixture();
    try {
      const start = data.execute('start-scans', overrides);
      assert.equal(start.status, 0, start.stderr);
      assert.deepEqual(start.calls.map((call) => call[0]), ['smctl']);
      assert.equal(data.execute('verify-scans', { ...overrides, DC_BG_WORK_DIR: path.join(data.root, 'dc-bg-jobs') }).status, 0);
    } finally { data.cleanup(); }
  }
});

test('does not generate SBOM when skipped or provided externally', () => {
  for (const overrides of [{ DC_SKIP_SBOM: 'true', DC_RUN_SBOM: 'false' }, { DC_RUN_SBOM: 'false' }]) {
    const data = fixture();
    try {
      const start = data.execute('start-scans', { ...overrides, DC_RUN_GITLEAKS: 'false' });
      assert.equal(start.status, 0, start.stderr);
      assert.deepEqual(start.calls, []);
      assert.equal(data.execute('verify-scans', { ...overrides, DC_RUN_GITLEAKS: 'false', DC_BG_WORK_DIR: path.join(data.root, 'dc-bg-jobs') }).status, 0);
    } finally { data.cleanup(); }
  }
});

test('continues uploads after a failure and reports failure', () => {
  const data = fixture();
  try {
    for (const file of ['codeql.zip', 'gitleaks.zip', 'sbom.json']) fs.writeFileSync(path.join(data.workspace, file), 'test');
    const result = data.execute('upload', { FAIL_CODEQL: 'true' });
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 3);
    assert.match(result.stderr, /One or more uploads failed/);
  } finally { data.cleanup(); }
});

test('rebuilds archives from scratch so stale entries and stale archives are never uploaded', () => {
  const data = fixture();
  try {
    const entries = (zip) => spawnSync('unzip', ['-Z1', path.join(data.workspace, zip)], { encoding: 'utf8' }).stdout.trim().split('\n');
    for (const [zip, stale] of [['codeql.zip', 'old-java.sarif'], ['gitleaks.zip', 'old-gitleaks.sarif']]) {
      fs.writeFileSync(path.join(data.root, stale), '{}');
      assert.equal(spawnSync('zip', ['-q', '-j', path.join(data.workspace, zip), path.join(data.root, stale)]).status, 0);
    }
    fs.mkdirSync(data.env.DC_SARIF_OUTPUT);
    fs.writeFileSync(path.join(data.env.DC_SARIF_OUTPUT, 'javascript.sarif'), '{}');
    fs.writeFileSync(path.join(data.workspace, 'gitleaks.sarif'), '{}');
    const packaged = data.execute('package-sarifs');
    assert.equal(packaged.status, 0, packaged.stderr);
    assert.deepEqual(entries('codeql.zip'), ['javascript.sarif']);
    assert.deepEqual(entries('gitleaks.zip'), ['gitleaks.sarif']);
    fs.rmSync(data.env.DC_SARIF_OUTPUT, { recursive: true });
    fs.rmSync(path.join(data.workspace, 'gitleaks.sarif'));
    const empty = data.execute('package-sarifs');
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(fs.existsSync(path.join(data.workspace, 'codeql.zip')), false);
    assert.equal(fs.existsSync(path.join(data.workspace, 'gitleaks.zip')), false);
    const upload = data.execute('upload', { DC_RUN_SBOM: 'false' });
    assert.equal(upload.status, 0, upload.stderr);
    assert.deepEqual(upload.calls, []);
  } finally { data.cleanup(); }
});

test('removes stale CodeQL results before analysis', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.env.DC_SARIF_OUTPUT);
    fs.writeFileSync(path.join(data.env.DC_SARIF_OUTPUT, 'stale.sarif'), '{}');
    const result = data.execute('resolve-languages', { DC_INPUT_LANGUAGES: 'java' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(data.env.DC_SARIF_OUTPUT), false);
    fs.mkdirSync(data.env.DC_SARIF_OUTPUT);
    const skipped = data.execute('resolve-languages', { DC_INPUT_LANGUAGES: 'java', DC_RUN_CODEQL: 'false' });
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.equal(fs.existsSync(data.env.DC_SARIF_OUTPUT), true, 'untouched when CodeQL is not run');
  } finally { data.cleanup(); }
});

test('packages CodeQL and Gitleaks SARIF independently', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.env.DC_SARIF_OUTPUT);
    fs.writeFileSync(path.join(data.env.DC_SARIF_OUTPUT, 'java.sarif'), '{}');
    fs.writeFileSync(path.join(data.workspace, 'gitleaks.sarif'), '{}');
    const result = data.execute('package-sarifs');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(data.workspace, 'codeql.zip')));
    assert.ok(fs.existsSync(path.join(data.workspace, 'gitleaks.zip')));
  } finally { data.cleanup(); }
});

test('packages only generated SARIF when one scanner is external', () => {
  for (const [scanner, generated] of [['CODEQL', 'gitleaks.zip'], ['GITLEAKS', 'codeql.zip']]) {
    const data = fixture();
    try {
      fs.mkdirSync(data.env.DC_SARIF_OUTPUT);
      fs.writeFileSync(path.join(data.env.DC_SARIF_OUTPUT, 'java.sarif'), '{}');
      fs.writeFileSync(path.join(data.workspace, 'gitleaks.sarif'), '{}');
      const result = data.execute('package-sarifs', { [`DC_RUN_${scanner}`]: 'false' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(path.join(data.workspace, generated)), true);
      assert.equal(fs.existsSync(path.join(data.workspace, scanner === 'CODEQL' ? 'codeql.zip' : 'gitleaks.zip')), false);
    } finally { data.cleanup(); }
  }
});

test('uploads multiple external scanner files and SBOM alongside generated CodeQL', () => {
  const data = fixture();
  try {
    const external = [
      { type: 'GITLEAKS', file: path.join(data.root, 'one.zip') },
      { type: 'GITLEAKS', file: path.join(data.root, 'two.zip') },
      { type: 'OTHER', file: path.join(data.root, 'other.zip') },
      { type: 'SBOM', file: path.join(data.root, 'external sbom.json') },
      { type: 'SBOM', file: path.join(data.root, 'second sbom.json') },
    ];
    for (const item of external) fs.writeFileSync(item.file, 'external');
    for (const file of ['codeql.zip', 'gitleaks.zip', 'sbom.json']) fs.writeFileSync(path.join(data.workspace, file), 'stale');
    fs.mkdirSync(data.env.DC_SARIF_OUTPUT);
    fs.writeFileSync(path.join(data.env.DC_SARIF_OUTPUT, 'java.sarif'), '{}');
    const settings = { DC_RUN_GITLEAKS: 'false', DC_RUN_SBOM: 'false', DC_EXTERNAL_ARTIFACTS: JSON.stringify(external) };
    const packaged = data.execute('package-sarifs', settings);
    assert.equal(packaged.status, 0, packaged.stderr);
    const result = data.execute('upload', settings);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 6);
    assert.equal(result.calls[0][result.calls[0].indexOf('--scanner-type') + 1], 'CODEQL');
    assert.deepEqual(result.calls.slice(1, 4).map((call) => call[call.indexOf('--scanner-type') + 1]), ['GITLEAKS', 'GITLEAKS', 'OTHER']);
    assert.deepEqual(result.calls.slice(1, 4).map((call) => call[call.indexOf('--file') + 1]), external.slice(0, 3).map((item) => item.file));
    assert.equal(result.calls[4][result.calls[4].indexOf('--file') + 1], external[3].file);
    assert.equal(result.calls[5][result.calls[5].indexOf('--file') + 1], external[4].file);
  } finally { data.cleanup(); }
});

test('passes an existing SARIF ZIP through unchanged', () => {
  const data = fixture();
  try {
    const zip = path.join(data.root, 'multiple.zip');
    fs.writeFileSync(path.join(data.workspace, 'one.sarif'), '{}');
    fs.writeFileSync(path.join(data.workspace, 'two.sarif'), '{}');
    const archive = spawnSync('zip', ['-j', zip, path.join(data.workspace, 'one.sarif'), path.join(data.workspace, 'two.sarif')], { encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);
    const contents = fs.readFileSync(zip);
    const settings = { DC_RUN_CODEQL: 'false', DC_RUN_SBOM: 'false', DC_SKIP_SBOM: 'true', DC_EXTERNAL_ARTIFACTS: JSON.stringify([{ type: 'CODEQL', file: zip }]) };
    const result = data.execute('package-sarifs', settings);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.readFileSync(zip).equals(contents));
    const uploaded = data.execute('upload', settings);
    assert.equal(uploaded.status, 0, uploaded.stderr);
    assert.equal(uploaded.calls[0][uploaded.calls[0].indexOf('--file') + 1], zip);
  } finally { data.cleanup(); }
});

test('removes downloaded external files after upload, even when an upload fails', () => {
  for (const failing of [false, true]) {
    const data = fixture();
    try {
      const directory = path.join(data.root, 'dc-external-test');
      fs.mkdirSync(directory);
      const external = [{ type: 'CODEQL', file: path.join(directory, '1-CODEQL.zip') }, { type: 'SBOM', file: path.join(directory, '2-SBOM.json') }];
      for (const item of external) fs.writeFileSync(item.file, 'private report');
      const result = data.execute('upload', { ...off, ...(failing ? { FAIL_CODEQL: 'true' } : {}), DC_EXTERNAL_ARTIFACTS: JSON.stringify(external) });
      assert.equal(result.status, failing ? 1 : 0, result.stderr);
      assert.equal(result.calls.length, 2);
      assert.equal(fs.existsSync(directory), false);
    } finally { data.cleanup(); }
  }
});

test('skip controls prevent stale artifact uploads even when paths are present', () => {
  const data = fixture();
  try {
    for (const file of ['codeql.zip', 'gitleaks.zip', 'sbom.json']) fs.writeFileSync(path.join(data.workspace, file), 'stale');
    const settings = { ...off, DC_SKIP_SARIF: 'true', DC_SKIP_SBOM: 'true', DC_EXTERNAL_ARTIFACTS: JSON.stringify([{ type: 'CODEQL', file: 'missing.zip' }, { type: 'SBOM', file: 'missing.json' }]), DC_RELEASE_ID: '' };
    assert.equal(data.execute('package-sarifs', settings).status, 0);
    const result = data.execute('upload', settings);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
  } finally { data.cleanup(); }
});

test('uploads only the enabled generated artifact type', () => {
  for (const [settings, expected] of [[{ DC_SKIP_SARIF: 'true', DC_RUN_CODEQL: 'false', DC_RUN_GITLEAKS: 'false' }, ['sbom']], [{ DC_SKIP_SBOM: 'true', DC_RUN_SBOM: 'false' }, ['scan', 'scan']]]) {
    const data = fixture();
    try {
      for (const file of ['codeql.zip', 'gitleaks.zip', 'sbom.json']) fs.writeFileSync(path.join(data.workspace, file), 'generated');
      const result = data.execute('upload', settings);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.calls.map((call) => call[1]), expected);
    } finally { data.cleanup(); }
  }
});

test('fails for missing external artifacts and still attempts other uploads', () => {
  const data = fixture();
  try {
    fs.writeFileSync(path.join(data.workspace, 'present.json'), '{}');
    const settings = { ...off, DC_EXTERNAL_ARTIFACTS: JSON.stringify([{ type: 'CODEQL', file: path.join(data.root, 'missing.zip') }, { type: 'SBOM', file: path.join(data.workspace, 'present.json') }]) };
    const result = data.execute('upload', settings);
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls.map((call) => call.slice(0, 3)), [['smctl', 'sbom', 'upload']]);
    const missingSbom = data.execute('upload', { ...off, DC_SKIP_SARIF: 'true', DC_EXTERNAL_ARTIFACTS: JSON.stringify([{ type: 'SBOM', file: path.join(data.root, 'missing.json') }]) });
    assert.equal(missingSbom.status, 1);
    assert.match(missingSbom.stderr, /SBOM is not a readable file/);
  } finally { data.cleanup(); }
});

test('rejects external artifacts that are not regular files', () => {
  const data = fixture();
  try {
    const result = data.execute('upload', { ...off, DC_SKIP_SBOM: 'true', DC_EXTERNAL_ARTIFACTS: JSON.stringify([{ type: 'CODEQL', file: data.root }]) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a readable file/);
  } finally { data.cleanup(); }
});