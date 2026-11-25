'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { child } = require('../src/common');

test('child joins a single file name onto an absolute base', () => {
  assert.equal(child('/work', 'gitleaks.log'), path.join('/work', 'gitleaks.log'));
  assert.equal(child('/work', 'my report.sarif'), path.join('/work', 'my report.sarif'));
});

test('child rejects traversal, separators, empty names and relative bases', () => {
  for (const name of ['..', '.', '', 'a/b', '../x', 'a\0b']) assert.throws(() => child('/work', name), /Invalid path segment/, JSON.stringify(name));
  assert.throws(() => child('work', 'file'), /Invalid path segment/);
  assert.throws(() => child('', 'file'), /Invalid path segment/);
});
