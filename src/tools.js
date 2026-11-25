'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { exportEnv, addPath, run } = require('./common');

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
  let sha = '';
  let version = `0.0.0-${env.DC_INPUT_CACHE_VERSION}`;
  if (env.DC_INPUT_USE_CHECKSUM === 'true') {
    // Fail closed: without a valid digest smctl must not be run.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sha-'));
    try {
      const file = path.join(temp, 'smctl.sha256');
      try { await fetch(`${env.DC_INPUT_CDN}/smctl.sha256`, file, 60); } catch {
        throw new Error(`SECURITY ERROR: could not fetch ${env.DC_INPUT_CDN}/smctl.sha256; refusing to run unverified smctl.\nSet use-binary-sha256-checksum: false only if you accept that risk.`);
      }
      const candidate = (fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0] || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(candidate)) {
        throw new Error('SECURITY ERROR: unexpected smctl.sha256 content; refusing to run unverified smctl.\nSet use-binary-sha256-checksum: false only if you accept that risk.');
      }
      sha = candidate;
      version = `0.0.0-${sha}`;
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
    SMCTL_CACHE_KEY: `smctl-${version}-linux-x64`,
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
  // In checksum mode a cached binary is re-hashed so a corrupted or poisoned entry is never executed.
  if (executable(file)) {
    if (!env.DC_SMCTL_SHA256) return console.log(`smctl found in tool cache @ ${env.DC_SMCTL_BIN_DIR} (checksum verification disabled)`);
    if (checksum(file) === env.DC_SMCTL_SHA256) return console.log(`smctl found in tool cache @ ${env.DC_SMCTL_BIN_DIR}; checksum verified.`);
    console.error('WARNING: cached smctl does not match the expected checksum; discarding and redownloading.');
    fs.rmSync(file, { force: true });
  }
  fs.mkdirSync(env.DC_SMCTL_BIN_DIR, { recursive: true });
  console.log(`Downloading smctl from ${env.DC_INPUT_CDN}/smctl`);
  await fetch(`${env.DC_INPUT_CDN}/smctl`, file, 120);
  if (env.DC_SMCTL_SHA256) {
    const actual = checksum(file);
    if (actual !== env.DC_SMCTL_SHA256) {
      fs.rmSync(file, { force: true });
      throw new Error(`SECURITY ERROR: smctl checksum mismatch.\nExpected: ${env.DC_SMCTL_SHA256}\nActual:   ${actual}`);
    }
    console.log('smctl checksum verified.');
  } else console.error('WARNING: use-binary-sha256-checksum is false; smctl checksum verification skipped.');
  fs.chmodSync(file, 0o755);
}

function downloadGitleaks() {
  const env = process.env;
  if (env.DC_RUN_GITLEAKS !== 'true') return;
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
  const tools = [[process.env.DC_SMCTL_BIN_DIR, 'smctl', ['--version']]];
  if (process.env.DC_RUN_GITLEAKS === 'true') {
    tools.push([process.env.DC_GITLEAKS_BIN_DIR, 'gitleaks', ['version']]);
  }
  for (const [directory, name, args] of tools) {
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