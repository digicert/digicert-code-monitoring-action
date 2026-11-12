'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tools-'));
  const envFile = path.join(directory, 'env');
  const log = path.join(directory, 'calls');
  fs.writeFileSync(envFile, '');
  for (const command of ['gh', 'smctl', 'curl']) {
    fs.writeFileSync(path.join(directory, command), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.CALL_LOG, JSON.stringify([${JSON.stringify(command)}, ...args]) + '\\n');\nif (${JSON.stringify(command)} === 'gh') console.log(process.env.GH_RESPONSE || '{}');\nif (${JSON.stringify(command)} === 'smctl') console.log(process.env.SMCTL_RESPONSE || 'Release ID: rel-123');\nif (${JSON.stringify(command)} === 'curl') { const source = args.at(-1).endsWith('_checksums.txt') ? process.env.DOWNLOAD_CHECKSUM || process.env.DOWNLOAD_SOURCE : process.env.DOWNLOAD_SOURCE; fs.copyFileSync(source, args[args.indexOf('-o') + 1]); }\n`, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_ENV: envFile, CALL_LOG: log };
  return {
    directory,
    execute(step, overrides = {}) {
      const entry = path.join(__dirname, `../${process.env.NODE_ACTION_ENTRY === 'dist' ? 'dist' : 'src'}/index.js`);
      const result = spawnSync(process.execPath, [entry, step], { env: { ...env, ...overrides }, encoding: 'utf8' });
      return { ...result, exported: fs.readFileSync(envFile, 'utf8'), calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
    },
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}

test('computes cache paths when checksum is disabled', () => {
  const data = fixture();
  try {
    const result = data.execute('cache-keys', { RUNNER_TOOL_CACHE: '/tool-cache', DC_USE_CHECKSUM: 'false', DC_CACHE_VERSION: '4', DC_GITLEAKS_VERSION: '8.18.4' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.exported, /DC_SMCTL_BIN_DIR<<[^\n]+\n\/tool-cache\/smctl\/0.0.0-4\/x64\n/);
    assert.match(result.exported, /SMCTL_CACHE_KEY<<[^\n]+\nsmctl-4-linux-x64\n/);
  } finally { data.cleanup(); }
});

test('verifies smctl checksum and rejects a mismatch', () => {
  const data = fixture();
  try {
    const source = path.join(data.directory, 'binary');
    fs.writeFileSync(source, 'binary content');
    const bin = path.join(data.directory, 'smctl-bin');
    const result = data.execute('download-smctl', { DC_SMCTL_BIN_DIR: bin, DC_INPUT_CDN: 'https://cdn.example', DC_SMCTL_SHA256: '0'.repeat(64), DOWNLOAD_SOURCE: source });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checksum mismatch/);
    assert.equal(fs.statSync(path.join(bin, 'smctl')).mode & 0o111, 0);
  } finally { data.cleanup(); }
});

test('downloads and enables smctl after a matching checksum', () => {
  const data = fixture();
  try {
    const source = path.join(data.directory, 'binary');
    fs.writeFileSync(source, 'binary content');
    const digest = crypto.createHash('sha256').update('binary content').digest('hex');
    const bin = path.join(data.directory, 'smctl-bin');
    const result = data.execute('download-smctl', { DC_SMCTL_BIN_DIR: bin, DC_INPUT_CDN: 'https://cdn.example', DC_SMCTL_SHA256: digest, DOWNLOAD_SOURCE: source });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(fs.statSync(path.join(bin, 'smctl')).mode & 0o111, 0);
    assert.match(result.stdout, /checksum verified/);
  } finally { data.cleanup(); }
});

test('includes the fetched checksum in the inner cache directory', () => {
  const data = fixture();
  try {
    const source = path.join(data.directory, 'checksum');
    const digest = 'a'.repeat(64);
    fs.writeFileSync(source, `${digest}  smctl\n`);
    const result = data.execute('cache-keys', { RUNNER_TOOL_CACHE: '/tool-cache', DC_INPUT_CDN: 'https://cdn.example', DC_USE_CHECKSUM: 'true', DC_GITLEAKS_VERSION: '8.18.4', DOWNLOAD_SOURCE: source });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.exported.includes(`/tool-cache/smctl/0.0.0-${digest}/x64`));
  } finally { data.cleanup(); }
});

test('uses cached smctl without downloading', () => {
  const data = fixture();
  try {
    const bin = path.join(data.directory, 'smctl-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'smctl'), 'cached', { mode: 0o755 });
    const result = data.execute('download-smctl', { DC_SMCTL_BIN_DIR: bin });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
  } finally { data.cleanup(); }
});

test('downloads and verifies the Gitleaks archive', () => {
  const data = fixture();
  try {
    const source = path.join(data.directory, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'gitleaks'), 'test binary');
    const archive = path.join(data.directory, 'archive.tar.gz');
    const tar = spawnSync('tar', ['-czf', archive, '-C', source, 'gitleaks'], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    const checksumFile = path.join(data.directory, 'checksums.txt');
    fs.writeFileSync(checksumFile, `${digest}  gitleaks_8.18.4_linux_x64.tar.gz\n`);
    const bin = path.join(data.directory, 'gitleaks-bin');
    const result = data.execute('download-gitleaks', { DC_GITLEAKS_BIN_DIR: bin, DC_GITLEAKS_VERSION: '8.18.4', DOWNLOAD_SOURCE: archive, DOWNLOAD_CHECKSUM: checksumFile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(bin, 'gitleaks'), 'utf8'), 'test binary');
    assert.notEqual(fs.statSync(path.join(bin, 'gitleaks')).mode & 0o111, 0);
  } finally { data.cleanup(); }
});

test('reuses release ID without calling external commands', () => {
  const data = fixture();
  try {
    const result = data.execute('create-release', { DC_INPUT_RELEASE_ID: ' release-42 ' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.exported, /DC_RELEASE_ID<<[^\n]+\nrelease-42\n/);
    assert.deepEqual(result.calls, []);
  } finally { data.cleanup(); }
});

test('build release uses override for smctl and triggering SHA for metadata', () => {
  const data = fixture();
  try {
    const result = data.execute('create-release', { DC_INPUT_WITH_RELEASE: 'false', DC_INPUT_NAME: '', DC_COMMIT_SHA: 'override', DC_REF_NAME: 'main', GITHUB_SHA: '1234567890', GITHUB_REPOSITORY: 'owner/repo', GITHUB_ACTOR: 'actor', GITHUB_RUN_ID: '456', GH_RESPONSE: '{"id":9,"node_id":"author-node"}' });
    assert.equal(result.status, 0, result.stderr);
    const args = result.calls.find((call) => call[0] === 'smctl');
    assert.equal(args[args.indexOf('--commit-sha') + 1], 'override');
    assert.equal(args[args.indexOf('--tag') + 1], '12345678');
    assert.equal(args[args.indexOf('--author-external-id') + 1], '9');
    assert.match(result.exported, /DC_RELEASE_ID<<[^\n]+\nrel-123\n/);
  } finally { data.cleanup(); }
});

test('provided release metadata skips release API lookup', () => {
  const data = fixture();
  try {
    const result = data.execute('create-release', { DC_INPUT_WITH_RELEASE: 'true', DC_INPUT_NAME: 'project', DC_INPUT_TAG: 'v1', DC_INPUT_RELEASE_URL: 'https://github.com/o/r/releases/tag/v1', DC_INPUT_RELEASE_NODE_ID: 'node-id', DC_INPUT_RELEASED_AT: '2024-01-01T00:00:00Z', GITHUB_ACTOR: 'actor' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.filter((call) => call[0] === 'gh').length, 1);
    assert.match(result.calls.find((call) => call[0] === 'gh')[2], /^users\//);
    assert.ok(result.calls.find((call) => call[0] === 'smctl').includes('RELEASED'));
  } finally { data.cleanup(); }
});

test('fetches release metadata when caller supplies only part of it', () => {
  const data = fixture();
  try {
    const result = data.execute('create-release', { DC_INPUT_WITH_RELEASE: 'true', DC_INPUT_NAME: 'project', DC_INPUT_TAG: 'v1', DC_INPUT_RELEASE_URL: 'https://ignored.example', GITHUB_REPOSITORY: 'owner/repo', GH_RESPONSE: '{"id":7,"node_id":"node","html_url":"https://release.example","published_at":"2024-01-01T00:00:00Z","author":{"id":4}}' });
    assert.equal(result.status, 0, result.stderr);
    const args = result.calls.find((call) => call[0] === 'smctl');
    assert.equal(args[args.indexOf('--release-url') + 1], 'https://release.example');
    assert.equal(args[args.indexOf('--external-id') + 1], '7');
    assert.match(result.calls.find((call) => call[0] === 'gh')[2], /releases\/tags\/v1$/);
  } finally { data.cleanup(); }
});

test('preserves the original failure on JSON-only smctl output', () => {
  const data = fixture();
  try {
    const result = data.execute('create-release', { DC_INPUT_WITH_RELEASE: 'false', GITHUB_SHA: '1234567890', GITHUB_REPOSITORY: 'owner/repo', GITHUB_ACTOR: 'actor', SMCTL_RESPONSE: '{"id":"json-id"}' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Could not parse Release ID/);
  } finally { data.cleanup(); }
});