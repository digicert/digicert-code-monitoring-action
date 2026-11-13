'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

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
    const script = `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.CALL_LOG, JSON.stringify([${JSON.stringify(command)}, ...args]) + '\\n');\nif (${JSON.stringify(command)} === 'gh') console.log(process.env.LANGUAGES || '');\nif (${JSON.stringify(command)} === 'gitleaks' && process.env.LARGE_SCAN_LOG) process.stdout.write('x'.repeat(2 * 1024 * 1024));\nif (${JSON.stringify(command)} === 'gitleaks') fs.writeFileSync(args[args.indexOf('--report-path') + 1], JSON.stringify({runs:[{results:[]}]}));\nif (${JSON.stringify(command)} === 'smctl' && args[1] === 'generate') fs.writeFileSync(args[args.indexOf('--output') + 1], '{}');\nif (${JSON.stringify(command)} === 'smctl' && args[1] === 'upload' && args.includes('CODEQL') && process.env.FAIL_CODEQL) process.exit(1);\n`;
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
    if (args[0] === 'add') fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'content');
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

test('creates scan artifacts sequentially and waits for exit markers', () => {
  const data = fixture();
  try {
    initializeGit(data.workspace);
    const result = data.execute('start-scans', { LARGE_SCAN_LOG: 'true' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map((call) => call[0]), ['gitleaks', 'smctl']);
    assert.ok(fs.existsSync(path.join(data.workspace, 'gitleaks.sarif')));
    assert.ok(fs.existsSync(path.join(data.workspace, 'sbom.json')));
    assert.ok(fs.statSync(path.join(data.root, 'dc-bg-jobs', 'gitleaks.log')).size > 2 * 1024 * 1024);
    const wait = data.execute('wait-scans', { DC_BG_WORK_DIR: path.join(data.root, 'dc-bg-jobs') });
    assert.equal(wait.status, 0, wait.stderr);
  } finally { data.cleanup(); }
});

test('runs Gitleaks while SBOM is skipped', () => {
  const data = fixture();
  try {
    initializeGit(data.workspace);
    const result = data.execute('start-scans', { DC_SKIP_SBOM: 'true', DC_RUN_SBOM: 'false' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls.map((call) => call[0]), ['gitleaks']);
    assert.equal(data.execute('wait-scans', { DC_RUN_SBOM: 'false', DC_BG_WORK_DIR: path.join(data.root, 'dc-bg-jobs'), DC_SCAN_TIMEOUT: '0' }).status, 0);
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

test('times out when scan markers are missing', () => {
  const data = fixture();
  try {
    const result = data.execute('wait-scans', { DC_BG_WORK_DIR: data.root, DC_SCAN_TIMEOUT: '0' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Timeout/);
  } finally { data.cleanup(); }
});

test('skips Gitleaks when SARIF is skipped or provided externally', () => {
  for (const overrides of [{ DC_SKIP_SARIF: 'true', DC_RUN_CODEQL: 'false', DC_RUN_GITLEAKS: 'false' }, { DC_RUN_GITLEAKS: 'false' }]) {
    const data = fixture();
    try {
      const start = data.execute('start-scans', overrides);
      assert.equal(start.status, 0, start.stderr);
      assert.deepEqual(start.calls.map((call) => call[0]), ['smctl']);
      assert.equal(data.execute('wait-scans', { ...overrides, DC_BG_WORK_DIR: path.join(data.root, 'dc-bg-jobs'), DC_SCAN_TIMEOUT: '0' }).status, 0);
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
      assert.equal(data.execute('wait-scans', { ...overrides, DC_RUN_GITLEAKS: 'false', DC_BG_WORK_DIR: path.join(data.root, 'dc-bg-jobs'), DC_SCAN_TIMEOUT: '0' }).status, 0);
    } finally { data.cleanup(); }
  }
});

test('reports failed scan markers even when logs are missing', () => {
  const data = fixture();
  try {
    fs.writeFileSync(path.join(data.root, 'gitleaks.exit'), '1\n');
    fs.writeFileSync(path.join(data.root, 'sbom.exit'), '0\n');
    const result = data.execute('wait-scans', { DC_BG_WORK_DIR: data.root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Gitleaks scan failed/);
  } finally { data.cleanup(); }
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
    const uploaded = data.execute('upload', settings);
    assert.equal(uploaded.status, 0, uploaded.stderr);
    assert.equal(uploaded.calls[0][uploaded.calls[0].indexOf('--file') + 1], zip);
    assert.ok(fs.readFileSync(zip).equals(contents));
  } finally { data.cleanup(); }
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