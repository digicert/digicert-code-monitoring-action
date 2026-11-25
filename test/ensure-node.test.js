'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.join(__dirname, '../scripts/ensure-node.sh');
const FALLBACK = '24.22.3';

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

// A fake `node` that reports the given version for the two calls the script makes.
function fakeNode(file, version) {
  executable(file, `#!/bin/sh
case "$1" in
  --version) echo "v${version}" ;;
  -p) echo "${version.split('.')[0]}" ;;
esac
`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ensure-node-'));
  const bin = path.join(root, 'bin');
  const temp = path.join(root, 'temp');
  const envFile = path.join(root, 'github_env');
  const curlLog = path.join(root, 'curl.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(temp);
  fs.writeFileSync(envFile, '');

  // The downloadable "tarball" contains a fake node that reports the pinned version.
  const payload = path.join(root, 'payload', `node-v${FALLBACK}-linux-x64`, 'bin');
  fs.mkdirSync(payload, { recursive: true });
  fakeNode(path.join(payload, 'node'), FALLBACK);
  const tarball = path.join(root, `node-v${FALLBACK}-linux-x64.tar.gz`);
  const tar = spawnSync('tar', ['-czf', tarball, '-C', path.join(root, 'payload'), `node-v${FALLBACK}-linux-x64`], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');

  executable(path.join(bin, 'uname'), '#!/bin/sh\n[ "$1" = "-m" ] && echo x86_64 || echo Linux\n');

  executable(path.join(bin, 'curl'), `#!/bin/sh
echo "$@" >> "${curlLog}"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  shift
done
[ -n "$FAIL_CURL" ] && exit 22
cp "${tarball}" "$out"
`);

  return {
    root, bin, temp, envFile, curlLog, digest,
    run(extraEnv = {}) {
      const result = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: {
          // Only system tools: the real node on the developer machine must not be visible.
          PATH: `${bin}:/usr/bin:/bin:/sbin`,
          HOME: root,
          GITHUB_ENV: envFile,
          RUNNER_TEMP: temp,
          DC_NODE_FALLBACK_SHA256: digest,
          ...extraEnv,
        },
      });
      return {
        ...result,
        exported: fs.readFileSync(envFile, 'utf8'),
        downloads: fs.existsSync(curlLog) ? fs.readFileSync(curlLog, 'utf8').trim().split('\n').filter(Boolean) : [],
      };
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('uses a Node.js 20 or newer already on PATH without downloading anything', () => {
  for (const version of ['20.0.0', '22.5.1', '26.1.0']) {
    const data = fixture();
    try {
      fakeNode(path.join(data.bin, 'node'), version);
      const result = data.run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.exported, `DC_NODE=${path.join(data.bin, 'node')}\n`, version);
      assert.deepEqual(result.downloads, [], version);
      assert.match(result.stdout, new RegExp(`Using Node.js v${version}`));
    } finally { data.cleanup(); }
  }
});

test('installs the pinned Node.js privately when PATH has an older or no Node.js', () => {
  for (const version of ['19.9.0', '18.20.4', '16.20.2', null]) {
    const data = fixture();
    try {
      if (version) fakeNode(path.join(data.bin, 'node'), version);
      const result = data.run();
      assert.equal(result.status, 0, `${version}: ${result.stderr}`);
      const installed = /^DC_NODE=(.+)\n$/.exec(result.exported)?.[1];
      assert.ok(installed, version);
      assert.ok(installed.startsWith(data.temp + path.sep), 'installed under the runner temp directory');
      assert.equal(fs.statSync(installed).mode & 0o100, 0o100);
      assert.equal(result.downloads.length, 1, version);
      assert.match(result.downloads[0], new RegExp(`https://nodejs\\.org/dist/v${FALLBACK.replaceAll('.', '\\.')}/node-v${FALLBACK.replaceAll('.', '\\.')}-linux-x64\\.tar\\.gz`));
      assert.match(result.downloads[0], /--proto =https/);
      assert.deepEqual(fs.readdirSync(path.dirname(installed)), ['node'], 'only the binary is kept');
    } finally { data.cleanup(); }
  }
});

test('rejects a tarball whose checksum does not match the pinned value', () => {
  const data = fixture();
  try {
    const result = data.run({ DC_NODE_FALLBACK_SHA256: '0'.repeat(64) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SECURITY ERROR: Node\.js checksum mismatch/);
    assert.equal(result.exported, '');
    assert.deepEqual(fs.readdirSync(data.temp), [], 'nothing left behind');
  } finally { data.cleanup(); }
});

test('explains how to proceed when the download fails', () => {
  const data = fixture();
  try {
    const result = data.run({ FAIL_CURL: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Failed to download Node\.js .*Allow access to nodejs\.org/);
    assert.equal(result.exported, '');
    assert.deepEqual(fs.readdirSync(data.temp), []);
  } finally { data.cleanup(); }
});

test('refuses to install on unsupported CPU architectures but still uses a suitable PATH Node.js', () => {
  const data = fixture();
  try {
    executable(path.join(data.bin, 'uname'), '#!/bin/sh\n[ "$1" = "-m" ] && echo aarch64 || echo Linux\n');
    const refused = data.run();
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /CPU architecture/);
    assert.deepEqual(refused.downloads, []);
    fakeNode(path.join(data.bin, 'node'), '22.0.0');
    const accepted = data.run();
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally { data.cleanup(); }
});

test('fails when the downloaded Node.js reports a different version than pinned', () => {
  const data = fixture();
  try {
    const payload = path.join(data.root, 'payload', `node-v${FALLBACK}-linux-x64`, 'bin', 'node');
    fakeNode(payload, '24.0.0');
    const tarball = path.join(data.root, `node-v${FALLBACK}-linux-x64.tar.gz`);
    spawnSync('tar', ['-czf', tarball, '-C', path.join(data.root, 'payload'), `node-v${FALLBACK}-linux-x64`]);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    const result = data.run({ DC_NODE_FALLBACK_SHA256: digest });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot run here/);
    assert.equal(result.exported, '');
  } finally { data.cleanup(); }
});
