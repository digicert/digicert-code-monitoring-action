'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportEnv, run, xargs } = require('./common');

function runLogged(command, args, log, options = {}) {
  const descriptor = fs.openSync(log, 'a');
  let result;
  try {
    result = run(command, args, { ...options, allowFailure: true, stdio: ['ignore', descriptor, descriptor] });
  } finally {
    fs.closeSync(descriptor);
  }
  if (result.status !== 0 && !options.ignoreFailure) throw new Error(`${command} failed (exit ${result.status}).`);
  return result;
}

function startScans() {
  const env = process.env;
  const work = path.join(env.RUNNER_TEMP, 'dc-bg-jobs');
  fs.mkdirSync(work, { recursive: true });
  exportEnv('DC_BG_WORK_DIR', work);
  const gitleaksLog = path.join(work, 'gitleaks.log');
  fs.writeFileSync(gitleaksLog, '');
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-scan-'));
  const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-archive-')), 'source.tar');
  try {
    runLogged('git', ['archive', '--output', archive, 'HEAD'], gitleaksLog, { cwd: env.GITHUB_WORKSPACE, env: { ...env, GIT_LFS_SKIP_SMUDGE: '1' } });
    runLogged('tar', ['-xf', archive, '-C', scanDir], gitleaksLog);
    runLogged('gitleaks', ['detect', '--source', scanDir, '--report-format', 'sarif', '--report-path', env.DC_GITLEAKS_SARIF_OUTPUT, '--no-banner', '--redact', '--no-git'], gitleaksLog, { cwd: env.GITHUB_WORKSPACE, ignoreFailure: true });
    if (!fs.existsSync(path.resolve(env.GITHUB_WORKSPACE, env.DC_GITLEAKS_SARIF_OUTPUT))) throw new Error('Gitleaks did not produce a SARIF report.');
    let findings = 0;
    try { findings = JSON.parse(fs.readFileSync(path.resolve(env.GITHUB_WORKSPACE, env.DC_GITLEAKS_SARIF_OUTPUT), 'utf8')).runs[0].results.length; } catch { findings = 0; }
    fs.appendFileSync(gitleaksLog, `Gitleaks findings: ${findings}\n`);
  } catch (error) {
    fs.appendFileSync(gitleaksLog, `${error.message}\n`);
    throw error;
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(archive), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(work, 'gitleaks.exit'), '0\n');
  const sbomLog = path.join(work, 'sbom.log');
  fs.writeFileSync(sbomLog, '');
  runLogged('smctl', ['sbom', 'generate', '--path', '.', '--output', env.DC_SBOM_OUTPUT, '--spec-version', env.DC_INPUT_SBOM_SPEC], sbomLog, { cwd: env.GITHUB_WORKSPACE });
  fs.writeFileSync(path.join(work, 'sbom.exit'), '0\n');
  console.log('Gitleaks and SBOM generation completed.');
}

function resolveLanguages() {
  const env = process.env;
  const priority = xargs((env.DC_INPUT_CODEQL_BUILD_MODE || 'none').toLowerCase());
  if (!['none', 'autobuild'].includes(priority)) throw new Error(`Invalid codeql-build-mode: '${priority}' (use none or autobuild).`);
  let languages = env.DC_INPUT_LANGUAGES || '';
  if (!languages) {
    const result = run('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/languages`, '--jq', 'keys[]'], { allowFailure: true });
    const mapping = { 'C#': 'csharp', Go: 'go', Java: 'java', Kotlin: 'java', JavaScript: 'javascript', TypeScript: 'javascript', Python: 'python', Ruby: 'ruby', Swift: 'swift' };
    const mapped = [];
    if (result.status === 0) {
      for (const language of result.stdout.split('\n')) {
        if (language === 'C' || language === 'C++') console.log(`Skipping ${language}: requires a manual build; not auto-scanned.`);
        const codeql = Object.hasOwn(mapping, language) ? mapping[language] : '';
        if (codeql && !mapped.includes(codeql)) mapped.push(codeql);
      }
    }
    languages = mapped.join(',');
    if (!languages) console.error('No CodeQL-supported languages detected; leaving empty for CodeQL autodetection fallback.');
  } else console.log(`Using languages override: ${languages}`);
  const list = languages.split(',').filter(Boolean);
  const hasBuild = list.some((language) => ['go', 'swift'].includes(language));
  const hasNone = list.some((language) => !['go', 'swift'].includes(language));
  let mode = priority;
  if (hasBuild && !hasNone) mode = 'autobuild';
  else if (hasNone && !hasBuild) mode = 'none';
  const output = list.filter((language) => mode === 'autobuild' ? ['go', 'swift'].includes(language) : !['go', 'swift'].includes(language)).join(',');
  exportEnv('DC_LANGUAGES', output);
  exportEnv('DC_CODEQL_BUILD_MODE', mode);
  console.log(`CodeQL build-mode: ${mode}; scanning: ${output || '<none matching this mode>'}`);
}

async function waitScans() {
  const work = process.env.DC_BG_WORK_DIR;
  const timeout = Number(process.env.DC_SCAN_TIMEOUT || '600');
  if (!Number.isInteger(timeout)) throw new Error('Invalid scan-timeout.');
  let elapsed = 0;
  while (!fs.existsSync(path.join(work, 'gitleaks.exit')) || !fs.existsSync(path.join(work, 'sbom.exit'))) {
    if (elapsed >= timeout) throw new Error(`Timeout: background jobs did not finish within ${timeout}s.`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    elapsed += 5;
  }
  let failed = false;
  for (const name of ['gitleaks', 'sbom']) {
    console.log(`----- ${name === 'sbom' ? 'sbom generate' : name} -----`);
    const log = path.join(work, `${name}.log`);
    if (fs.existsSync(log)) process.stdout.write(fs.readFileSync(log, 'utf8'));
    if (fs.readFileSync(path.join(work, `${name}.exit`), 'utf8').trim() !== '0') {
      console.error(`${name === 'sbom' ? 'SBOM generate' : 'Gitleaks scan'} failed.`);
      failed = true;
    }
  }
  if (failed) throw new Error('One or more scans failed.');
}

function sarifFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sarifFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.sarif')) files.push(file);
  }
  return files.sort();
}

function packageSarifs() {
  const env = process.env;
  const codeql = env.DC_SARIF_OUTPUT;
  const files = fs.existsSync(codeql) ? (fs.statSync(codeql).isDirectory() ? sarifFiles(codeql) : [codeql]) : [];
  if (files.length) {
    const result = run('zip', ['-j', env.DC_CODEQL_SCAN_ZIP, ...files]);
    process.stdout.write(result.stdout || '');
  } else console.error(`CodeQL SARIF (${codeql}) not found or empty; skipping CodeQL scan upload.`);
  if (fs.existsSync(env.DC_GITLEAKS_SARIF_OUTPUT)) {
    const result = run('zip', ['-j', env.DC_GITLEAKS_SCAN_ZIP, env.DC_GITLEAKS_SARIF_OUTPUT]);
    process.stdout.write(result.stdout || '');
  } else console.error(`Gitleaks SARIF (${env.DC_GITLEAKS_SARIF_OUTPUT}) not found; skipping its scan upload.`);
}

function upload() {
  const env = process.env;
  if (!env.DC_RELEASE_ID) throw new Error('No RELEASE_ID available; cannot upload.');
  const targets = [
    ['CodeQL SARIF', env.DC_CODEQL_SCAN_ZIP, ['scan', 'upload', '--file', env.DC_CODEQL_SCAN_ZIP, '--release-id', env.DC_RELEASE_ID, '--scanner-type', 'CODEQL', '--ref-branch', env.DC_REF_NAME || '', '--commit-sha', env.DC_COMMIT_SHA || '']],
    ['Gitleaks SARIF', env.DC_GITLEAKS_SCAN_ZIP, ['scan', 'upload', '--file', env.DC_GITLEAKS_SCAN_ZIP, '--release-id', env.DC_RELEASE_ID, '--scanner-type', 'GITLEAKS', '--ref-branch', env.DC_REF_NAME || '', '--commit-sha', env.DC_COMMIT_SHA || '']],
    ['SBOM', env.DC_SBOM_OUTPUT, ['sbom', 'upload', '--file', env.DC_SBOM_OUTPUT, '--release-id', env.DC_RELEASE_ID, '--commit-sha', env.DC_COMMIT_SHA || '', '--ref-branch', env.DC_REF_NAME || '']],
  ];
  let failed = false;
  for (const [name, file, args] of targets) {
    console.log(`--- Upload: ${name} ---`);
    if (!fs.existsSync(file)) { console.log(`No ${name} file found; skipping.`); continue; }
    const result = run('smctl', args, { allowFailure: true });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) { console.error(`${name} upload: FAILED`); failed = true; }
    else console.log(`${name} upload: OK`);
  }
  if (failed) throw new Error('One or more uploads failed.');
  console.log(`All scans and SBOM uploaded to release ${env.DC_RELEASE_ID}.`);
}

module.exports = { startScans, resolveLanguages, waitScans, packageSarifs, upload };