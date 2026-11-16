'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Resolves one file name inside an absolute base, rejecting anything that escapes it.
function child(base, name) {
  const segment = String(name);
  if (!path.isAbsolute(base) || segment.includes('\0') || path.basename(segment) !== segment) throw new Error('Invalid path segment.');
  const root = path.resolve(base);
  const target = path.resolve(root, segment);
  if (path.dirname(target) !== root) throw new Error('Invalid path segment.');
  return target;
}

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

module.exports = { exportEnv, addPath, run, xargs, child };