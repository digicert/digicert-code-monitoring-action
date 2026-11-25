'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function execute(step, env) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-setup-'));
  const envFile = path.join(directory, 'env');
  fs.writeFileSync(envFile, '');
  const entry = path.join(__dirname, `../${process.env.NODE_ACTION_ENTRY === 'dist' ? 'dist' : 'src'}/index.js`);
  const result = spawnSync(process.execPath, [entry, step], {
    env: { ...process.env, ...env, GITHUB_ENV: envFile }, encoding: 'utf8',
  });
  const output = fs.readFileSync(envFile, 'utf8');
  fs.rmSync(directory, { recursive: true, force: true });
  return { ...result, output };
}

test('normalizes inputs and safely writes runner environment', () => {
  const result = execute('normalize-inputs', { RAW_HOST: ' https://example.com/ ', RAW_CDN: 'https://cdn.example/', RAW_API_KEY: 'secret', RAW_LANGUAGES: 'Java, Python', RAW_NAME: '__DC_EOF__' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /DC_INPUT_HOST<<[^\n]+\nhttps:\/\/example.com\n/);
  assert.match(result.output, /DC_INPUT_LANGUAGES<<[^\n]+\njava,python\n/);
  assert.doesNotMatch(result.output, /secret/);
});

test('rejects unsafe inputs', () => {
  const base = { RAW_HOST: 'https://example.com', RAW_CDN: 'https://cdn.example', RAW_API_KEY: 'secret' };
  for (const override of [{ RAW_API_KEY: 'bad\nvalue' }, { RAW_HOST: 'http://example.com' }, { RAW_LANGUAGES: 'java,../../x' }]) {
    assert.equal(execute('normalize-inputs', { ...base, ...override }).status, 1);
  }
});

test('validates external artifact inputs and skip precedence', () => {
  const base = { RAW_HOST: 'https://example.com', RAW_CDN: 'https://cdn.example', RAW_API_KEY: 'secret' };
  assert.equal(execute('normalize-inputs', { ...base, RAW_EXTERNAL_PATHS: '["GITLEAKS:http://example.com/file"]' }).status, 1);
  assert.equal(execute('normalize-inputs', { ...base, RAW_SKIP_SBOM: 'maybe' }).status, 1);
  assert.equal(execute('normalize-inputs', { ...base, RAW_EXTERNAL_PATHS: '["bad entry"]' }).status, 1);
  const skipped = execute('normalize-inputs', { ...base, RAW_SKIP_SARIF: 'true', RAW_EXTERNAL_PATHS: '["GITLEAKS:not-a-url"]' });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.output, /DC_EXTERNAL_ARTIFACTS<<[^\n]+\n\[\]\n/);
  const unused = execute('normalize-inputs', { ...base, RAW_SKIP_SARIF: 'true', RAW_LANGUAGES: 'invalid!language', RAW_SKIP_SBOM: 'true', RAW_SBOM_SPEC: 'invalid' });
  assert.equal(unused.status, 0, unused.stderr);
  const lines = execute('normalize-inputs', { ...base, RAW_SKIP_SARIF: 'true', RAW_EXTERNAL_PATHS: 'GITLEAKS:not-a-url\n\nCODEQL:also-not-a-url\n' });
  assert.equal(lines.status, 0, lines.stderr);
  assert.match(lines.output, /DC_EXTERNAL_ARTIFACTS<<[^\n]+\n\[\]\n/);
  assert.equal(execute('normalize-inputs', { ...base, RAW_EXTERNAL_PATHS: 'SBOM:http://example.com/file\n' }).status, 1);
  assert.equal(execute('normalize-inputs', { ...base, RAW_EXTERNAL_PATHS: 'bad entry' }).status, 1);
});

test('validates and exports tool inputs used in URLs, cache keys and paths', () => {
  const base = { RAW_HOST: 'https://example.com', RAW_CDN: 'https://cdn.example', RAW_API_KEY: 'secret' };
  const defaults = execute('normalize-inputs', base);
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.match(defaults.output, /DC_INPUT_USE_CHECKSUM<<[^\n]+\ntrue\n/);
  assert.match(defaults.output, /DC_INPUT_CACHE_VERSION<<[^\n]+\n0\.0\.0-0\n/);
  assert.match(defaults.output, /DC_GITLEAKS_VERSION<<[^\n]+\n8\.18\.4\n/);
  assert.match(defaults.output, /DC_CODEQL_TOOLS_VERSION<<[^\n]+\n\n/);
  const custom = execute('normalize-inputs', { ...base, RAW_USE_CHECKSUM: 'FALSE', RAW_CACHE_VERSION: 'v2.1_a', RAW_GITLEAKS_VERSION: '8.19.0', RAW_CODEQL_TOOLS_VERSION: '2.17.6' });
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.output, /DC_INPUT_USE_CHECKSUM<<[^\n]+\nfalse\n/);
  assert.match(custom.output, /DC_GITLEAKS_VERSION<<[^\n]+\n8\.19\.0\n/);
  assert.match(custom.output, /DC_CODEQL_TOOLS_VERSION<<[^\n]+\n2\.17\.6\n/);
  for (const override of [
    { RAW_USE_CHECKSUM: 'maybe' },
    { RAW_CACHE_VERSION: '../escape' },
    { RAW_CACHE_VERSION: '-leading' },
    { RAW_CACHE_VERSION: 'a'.repeat(65) },
    { RAW_CACHE_VERSION: 'ok\nINJECTED=1' },
    { RAW_GITLEAKS_VERSION: '8.18' },
    { RAW_GITLEAKS_VERSION: '8.18.4/../../x' },
    { RAW_GITLEAKS_VERSION: '8.18.4\nINJECTED=1' },
    { RAW_CODEQL_TOOLS_VERSION: 'bad version' },
    { RAW_CODEQL_TOOLS_VERSION: '2.17.6\nINJECTED=1' },
  ]) {
    const result = execute('normalize-inputs', { ...base, ...override });
    assert.equal(result.status, 1, JSON.stringify(override));
    assert.equal(result.output, '', JSON.stringify(override));
  }
});

test('validates scan-timeout before any scan runs', () => {
  const base = { RAW_HOST: 'https://example.com', RAW_CDN: 'https://cdn.example', RAW_API_KEY: 'secret' };
  const exported = (output) => /DC_INPUT_SCAN_TIMEOUT<<[^\n]+\n(\d+)\n/.exec(output)?.[1];
  assert.equal(exported(execute('normalize-inputs', base).output), '600');
  for (const [raw, expected] of [['1', '1'], ['600', '600'], [' 90 ', '90'], ['21600', '21600']]) {
    const result = execute('normalize-inputs', { ...base, RAW_SCAN_TIMEOUT: raw });
    assert.equal(result.status, 0, `${raw}: ${result.stderr}`);
    assert.equal(exported(result.output), expected, raw);
  }
  for (const raw of ['0', '-1', '-600', 'abc', '1.5', '1e3', '0x10', '21601', '99999', '007', '5\n6']) {
    const result = execute('normalize-inputs', { ...base, RAW_SCAN_TIMEOUT: raw });
    assert.equal(result.status, 1, JSON.stringify(raw));
    assert.match(result.stderr, /Invalid scan-timeout/, JSON.stringify(raw));
    assert.equal(result.output, '', JSON.stringify(raw));
  }
});

test('computes run flags from skip settings', () => {
  const base = { RAW_HOST: 'https://example.com', RAW_CDN: 'https://cdn.example', RAW_API_KEY: 'secret' };
  const flags = (output) => Object.fromEntries(['CODEQL', 'GITLEAKS', 'SBOM'].map((name) => [name, new RegExp(`DC_RUN_${name}<<[^\\n]+\\n(\\w+)\\n`).exec(output)[1]]));
  assert.deepEqual(flags(execute('normalize-inputs', base).output), { CODEQL: 'true', GITLEAKS: 'true', SBOM: 'true' });
  assert.deepEqual(flags(execute('normalize-inputs', { ...base, RAW_SKIP_SARIF: 'true' }).output), { CODEQL: 'false', GITLEAKS: 'false', SBOM: 'true' });
  assert.deepEqual(flags(execute('normalize-inputs', { ...base, RAW_SKIP_SBOM: 'true' }).output), { CODEQL: 'true', GITLEAKS: 'true', SBOM: 'false' });
});

test('resolves pull request context and commit overrides', () => {
  const result = execute('resolve-context', { GITHUB_REPOSITORY_OWNER: 'owner', GITHUB_REPOSITORY: 'owner/repo', GITHUB_EVENT_NAME: 'pull_request', GITHUB_HEAD_REF: 'feature', GITHUB_REF_NAME: '1/merge', GITHUB_SHA: 'original', DC_INPUT_COMMIT_SHA: ' override ', GITHUB_WORKSPACE: '/work' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /DC_REF_NAME<<[^\n]+\nfeature\n/);
  assert.match(result.output, /DC_COMMIT_SHA<<[^\n]+\noverride\n/);
});

test('preserves quoted trailing whitespace when normalizing with xargs', () => {
  const result = execute('resolve-context', { GITHUB_REPOSITORY_OWNER: 'owner', GITHUB_REPOSITORY: 'owner/repo', DC_INPUT_BRANCH: "'branch  '", GITHUB_WORKSPACE: '/work' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /DC_REF_NAME<<[^\n]+\nbranch  \n/);
});