'use strict';

const setup = require('./setup');
const tools = require('./tools');
const release = require('./release');
const scans = require('./scans');

function guardTrigger() {
  if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
    throw new Error('This action must not run on pull_request_target due to secret exposure risk.\nUse pull_request (or push/workflow_dispatch) instead.');
  }
}

const steps = {
  'guard-trigger': guardTrigger,
  'normalize-inputs': setup.normalizeInputs,
  'export-auth': setup.exportAuth,
  'resolve-context': setup.resolveContext,
  'cache-keys': tools.cacheKeys,
  'download-smctl': tools.downloadSmctl,
  'download-gitleaks': tools.downloadGitleaks,
  'add-tools': tools.addTools,
  'create-release': release.createRelease,
  'start-scans': scans.startScans,
  'resolve-languages': scans.resolveLanguages,
  'wait-scans': scans.waitScans,
  'package-sarifs': scans.packageSarifs,
  'upload': scans.upload,
};

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('Node.js 24 or newer is required on the runner.');
  }
  const step = process.argv[2];
  if (!Object.hasOwn(steps, step)) {
    throw new Error(`Unknown action step: ${step}`);
  }
  await steps[step]();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});