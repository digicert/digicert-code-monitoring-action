'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('composite Node steps use the bundled action directory', () => {
  const action = fs.readFileSync(path.join(__dirname, '../action.yml'), 'utf8');
  const runners = action.match(/^      run: node "\$ACTION_DIR\/dist\/index\.js" [\w-]+$/gm) || [];
  assert.equal(runners.length, 14);
  assert.equal((action.match(/^        ACTION_DIR: \$\{\{ github\.action_path \}\}$/gm) || []).length, 14);
  assert.doesNotMatch(action, /^      run: \|/m);
});

test('bundled action rejects unsafe events', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../dist/index.js'), 'guard-trigger'], { env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request_target' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret exposure risk/);
});

test('composite conditions read Node-computed run flags only on uses steps', () => {
  const action = fs.readFileSync(path.join(__dirname, '../action.yml'), 'utf8');
  const section = (name) => action.split(`    - name: ${name}\n`)[1]?.split(/\n    - name: /)[0];
  for (const [name, flag] of [['Restore gitleaks from cache', 'GITLEAKS'], ['Initialize CodeQL', 'CODEQL'], ['Perform CodeQL Analysis', 'CODEQL']]) {
    assert.ok(section(name)?.includes(`env.DC_RUN_${flag} == 'true'`), name);
  }
  for (const name of ['Download and verify gitleaks', 'Start Gitleaks scan and SBOM generate (background)', 'Resolve CodeQL languages', 'Wait for Gitleaks and SBOM generate']) {
    assert.doesNotMatch(section(name), /^      if:/m, name);
  }
  assert.doesNotMatch(action, /DC_HAS_EXTERNAL_|DC_SKIP_/);
  for (const name of ['Package each SARIF independently', 'Upload scans and SBOM (sequential)']) {
    assert.match(section(name), /always\(\) && steps\.normalize_inputs\.outcome == 'success'/, name);
  }
});