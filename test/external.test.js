'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { parseExternal, httpsUrl } = require('../src/external');

test('parses typed HTTPS URLs, including URL colons and multiple reports', () => {
  const entries = parseExternal(JSON.stringify(['gitleaks:https://example.com:443/a.zip?token=value', 'CODEQL:https://example.com/b.zip', 'SBOM:https://example.com/c.json', 'GITLEAKS:https://example.com/d.zip']), false, false);
  assert.deepEqual(entries.map((entry) => entry.type), ['GITLEAKS', 'CODEQL', 'SBOM', 'GITLEAKS']);
  assert.equal(new URL(entries[0].url).searchParams.get('token'), 'value');
});

test('rejects invalid input without exposing URL secrets', () => {
  for (const raw of ['{', '{}', '[1]', '["CODEQL"]', '["../x:https://example.com"]', '["CODEQL:http://example.com/?secret=hidden"]', '["CODEQL:https:example.com"]', '["CODEQL:https://user:password@example.com"]', '["CODEQL:https://example.com/with space"]']) {
    assert.throws(() => parseExternal(raw, false, false), (error) => !/hidden|password/.test(error.message));
  }
  assert.throws(() => httpsUrl('file:///etc/passwd'));
});

test('ignores URLs for skipped artifact categories after validating structure', () => {
  const entries = parseExternal('["GITLEAKS:not-a-url","SBOM:https://example.com/a.json"]', false, true);
  assert.deepEqual(entries.map((entry) => entry.type), ['SBOM']);
  assert.deepEqual(parseExternal('["SBOM:not-a-url","CODEQL:not-a-url"]', true, true), []);
  assert.throws(() => parseExternal('["missing-separator"]', true, true));
});

test('downloads enabled files before exporting state, with secure redirect and failure handling', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-https-test-'));
  let server;
  try {
    const key = path.join(directory, 'key.pem');
    const cert = path.join(directory, 'cert.pem');
    const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
    assert.equal(certificate.status, 0, certificate.stderr);
    const requests = [];
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
      requests.push(request.url);
      if (request.url.startsWith('/redirect')) { response.writeHead(302, { location: '/file' }); response.end(); }
      else if (request.url.startsWith('/cross-origin')) { response.writeHead(302, { location: 'https://other.example/file?secret=hidden' }); response.end(); }
      else if (request.url.startsWith('/downgrade')) { response.writeHead(302, { location: 'http://example.com/file' }); response.end(); }
      else if (request.url.startsWith('/failure')) { response.writeHead(404); response.end(); }
      else { response.writeHead(200); response.end('artifact bytes'); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `https://127.0.0.1:${server.address().port}`;
    const execute = async (entries, extra = {}) => {
      const envFile = path.join(directory, `env-${Math.random()}`);
      fs.writeFileSync(envFile, '');
      const entry = path.join(__dirname, `../${process.env.NODE_ACTION_ENTRY === 'dist' ? 'dist' : 'src'}/index.js`);
      const child = spawn(process.execPath, [entry, 'normalize-inputs'], { env: { ...process.env, RAW_HOST: 'https://example.com', RAW_CDN: 'https://cdn.example', RAW_API_KEY: 'secret', RAW_EXTERNAL_PATHS: JSON.stringify(entries), RUNNER_TEMP: directory, GITHUB_ENV: envFile, NODE_EXTRA_CA_CERTS: cert, ...extra } });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      return { status, output, exported: fs.readFileSync(envFile, 'utf8') };
    };
    const result = await execute([`GITLEAKS:${base}/redirect?token=hidden`, `SBOM:${base}/file`]);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output + result.exported, /token=hidden/);
    const manifest = JSON.parse(/DC_EXTERNAL_ARTIFACTS<<[^\n]+\n([^\n]+)\n/.exec(result.exported)[1]);
    assert.deepEqual(manifest.map((item) => item.type), ['GITLEAKS', 'SBOM']);
    assert.equal(fs.readFileSync(manifest[0].file, 'utf8'), 'artifact bytes');
    assert.match(result.exported, /DC_RUN_GITLEAKS<<[^\n]+\nfalse\n/);
    assert.match(result.exported, /DC_RUN_CODEQL<<[^\n]+\ntrue\n/);
    const calls = path.join(directory, 'uploads.jsonl');
    const smctl = path.join(directory, 'smctl');
    fs.writeFileSync(smctl, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.UPLOAD_LOG, JSON.stringify(args) + '\\n');\nif (fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8') !== 'artifact bytes') process.exit(1);\n`, { mode: 0o755 });
    const entry = path.join(__dirname, `../${process.env.NODE_ACTION_ENTRY === 'dist' ? 'dist' : 'src'}/index.js`);
    const upload = spawnSync(process.execPath, [entry, 'upload'], { encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, UPLOAD_LOG: calls, GITHUB_WORKSPACE: directory, DC_RELEASE_ID: 'test-release', DC_EXTERNAL_ARTIFACTS: JSON.stringify(manifest), DC_CODEQL_SCAN_ZIP: path.join(directory, 'no-codeql.zip') } });
    assert.equal(upload.status, 0, upload.stderr);
    const uploads = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(uploads.map((args) => args[0]), ['scan', 'sbom']);
    assert.equal(uploads[0][uploads[0].indexOf('--scanner-type') + 1], 'GITLEAKS');
    const directories = fs.readdirSync(directory).filter((name) => name.startsWith('dc-external-'));
    const failed = await execute([`CODEQL:${base}/failure?secret=hidden`]);
    assert.equal(failed.status, 1);
    assert.match(failed.output, /HTTP 404/);
    assert.doesNotMatch(failed.output + failed.exported, /secret=hidden/);
    assert.equal(failed.exported, '');
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.startsWith('dc-external-')), directories);
    const redirected = await execute([`CODEQL:${base}/cross-origin`]);
    assert.equal(redirected.status, 1);
    assert.match(redirected.output, /different origin/);
    const downgrade = await execute([`CODEQL:${base}/downgrade`]);
    assert.equal(downgrade.status, 1);
    assert.match(downgrade.output, /invalid redirect/);
    const count = requests.length;
    const skipped = await execute(['GITLEAKS:not-a-url'], { RAW_SKIP_SARIF: 'true' });
    assert.equal(skipped.status, 0, skipped.output);
    assert.equal(requests.length, count);
    const invalidSecond = await execute([`GITLEAKS:${base}/file`, 'SBOM:http://example.com/file']);
    assert.equal(invalidSecond.status, 1);
    assert.equal(requests.length, count);
    const invalidLanguages = await execute([`GITLEAKS:${base}/file`], { RAW_LANGUAGES: 'invalid!' });
    assert.equal(invalidLanguages.status, 1);
    assert.equal(requests.length, count);
    const externalCodeql = await execute([`CODEQL:${base}/file`], { RAW_LANGUAGES: 'invalid!' });
    assert.equal(externalCodeql.status, 0, externalCodeql.output);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});