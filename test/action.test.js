'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('composite Node steps run the bundle through the selected Node.js', () => {
  const action = fs.readFileSync(path.join(__dirname, '../action.yml'), 'utf8');
  const runners = action.match(/^      run: '"\$DC_NODE" "\$ACTION_DIR\/dist\/index\.js" [\w-]+'$/gm) || [];
  assert.equal(runners.length, 14);
  assert.equal((action.match(/^        ACTION_DIR: \$\{\{ github\.action_path \}\}$/gm) || []).length, 15);
  assert.doesNotMatch(action, /^      run: node /m);
  assert.doesNotMatch(action, /^      run: \|/m);
  const first = action.split('  steps:\n')[1];
  assert.match(first, /^    # 0 -+\n    - name: Select Node\.js runtime\n      shell: bash\n      env:\n        ACTION_DIR: .*\n      run: bash "\$ACTION_DIR\/scripts\/ensure-node\.sh"/);
});

test('bundled action rejects unsafe events', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../dist/index.js'), 'guard-trigger'], { env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request_target' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /secret exposure risk/);
});

test('composite conditions read Node-computed run flags only on uses steps', () => {
  const action = fs.readFileSync(path.join(__dirname, '../action.yml'), 'utf8');
  const section = (name) => action.split(`    - name: ${name}\n`)[1]?.split(/\n    - name: /)[0];
  for (const [name, flag] of [['Initialize CodeQL', 'CODEQL'], ['Perform CodeQL Analysis', 'CODEQL']]) {
    assert.ok(section(name)?.includes(`env.DC_RUN_${flag} == 'true'`), name);
  }
  for (const name of ['Download and verify gitleaks', 'Run Gitleaks scan and SBOM generate', 'Resolve CodeQL languages', 'Check Gitleaks and SBOM generate results']) {
    assert.doesNotMatch(section(name), /^      if:/m, name);
  }
  assert.equal(section('Restore gitleaks from cache'), undefined, 'Gitleaks is never restored from a cache');
  assert.doesNotMatch(action, /GITLEAKS_CACHE_KEY|GITLEAKS_TOOL_CACHE_ROOT|background/i);
  assert.doesNotMatch(action, /DC_HAS_EXTERNAL_|DC_SKIP_/);
  for (const name of ['Package each SARIF independently', 'Upload scans and SBOM (sequential)']) {
    assert.match(section(name), /always\(\) && steps\.normalize_inputs\.outcome == 'success'/, name);
  }
});