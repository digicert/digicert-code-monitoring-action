'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-build-'));
try {
  const ncc = path.join(root, 'node_modules', '.bin', 'ncc');
  const result = spawnSync(ncc, ['build', path.join(root, 'src', 'index.js'), '-o', temp, '--no-cache'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Bundle build failed.');
  if (!fs.readFileSync(path.join(temp, 'index.js')).equals(fs.readFileSync(path.join(root, 'dist', 'index.js')))) {
    throw new Error('The bundled action is out of date. Run npm run build.');
  }
  console.log('Bundled action matches source.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}