'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const entry = path.join(__dirname, `../${process.env.NODE_ACTION_ENTRY === 'dist' ? 'dist' : 'src'}/index.js`);

test('rejects pull_request_target', () => {
  const result = spawnSync(process.execPath, [entry, 'guard-trigger'], {
    env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request_target' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret exposure risk/);
});

test('allows pull_request and push', () => {
  for (const event of ['pull_request', 'push']) {
    const result = spawnSync(process.execPath, [entry, 'guard-trigger'], {
      env: { ...process.env, GITHUB_EVENT_NAME: event },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
});