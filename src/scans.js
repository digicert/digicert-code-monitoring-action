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

function scanJobs(env) {
  const jobs = [];
  if (env.DC_RUN_GITLEAKS === 'true') jobs.push('gitleaks');
  if (env.DC_RUN_SBOM === 'true') jobs.push('sbom');
  return jobs;
}

function runGitleaks(env, work) {
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
}

function startScans() {
  const env = process.env;
  const work = path.join(env.RUNNER_TEMP, 'dc-bg-jobs');
  fs.mkdirSync(work, { recursive: true });
  exportEnv('DC_BG_WORK_DIR', work);
  if (env.DC_RUN_GITLEAKS === 'true') runGitleaks(env, work);
  if (env.DC_RUN_SBOM === 'true') {
    const sbomLog = path.join(work, 'sbom.log');
    fs.writeFileSync(sbomLog, '');
    runLogged('smctl', ['sbom', 'generate', '--path', '.', '--output', env.DC_SBOM_OUTPUT, '--spec-version', env.DC_INPUT_SBOM_SPEC], sbomLog, { cwd: env.GITHUB_WORKSPACE });
    fs.writeFileSync(path.join(work, 'sbom.exit'), '0\n');
  }
  console.log('Requested scans and SBOM generation completed.');
}

function resolveLanguages() {
  const env = process.env;
  if (env.DC_RUN_CODEQL !== 'true') return;
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
  const jobs = scanJobs(process.env);
  const timeout = Number(process.env.DC_SCAN_TIMEOUT || '600');
  if (!Number.isInteger(timeout)) throw new Error('Invalid scan-timeout.');
  let elapsed = 0;
  while (jobs.some((name) => !fs.existsSync(path.join(work, `${name}.exit`)))) {
    if (elapsed >= timeout) throw new Error(`Timeout: background jobs did not finish within ${timeout}s.`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    elapsed += 5;
  }
  let failed = false;
  for (const name of jobs) {
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

function externalFile(input, label) {
  const file = path.resolve(process.env.GITHUB_WORKSPACE, input);
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a regular file');
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    throw new Error(`${label} is not a readable file: ${file}`);
  }
  return file;
}

function packageSarifs() {
  const env = process.env;
  if (env.DC_RUN_CODEQL === 'true') {
    const codeql = env.DC_SARIF_OUTPUT;
    const files = fs.existsSync(codeql) ? (fs.statSync(codeql).isDirectory() ? sarifFiles(codeql) : [codeql]) : [];
    if (files.length) {
      const result = run('zip', ['-j', env.DC_CODEQL_SCAN_ZIP, ...files]);
      process.stdout.write(result.stdout || '');
    } else console.error(`CodeQL SARIF (${codeql}) not found or empty; skipping CodeQL scan upload.`);
  }
  if (env.DC_RUN_GITLEAKS === 'true') {
    if (fs.existsSync(env.DC_GITLEAKS_SARIF_OUTPUT)) {
      const result = run('zip', ['-j', env.DC_GITLEAKS_SCAN_ZIP, env.DC_GITLEAKS_SARIF_OUTPUT]);
      process.stdout.write(result.stdout || '');
    } else console.error(`Gitleaks SARIF (${env.DC_GITLEAKS_SARIF_OUTPUT}) not found; skipping its scan upload.`);
  }
}

function uploadTargets(env) {
  const targets = [];
  const addSarif = (name, file, scanner, required) => targets.push({ name, file, required, args: ['scan', 'upload', '--file', file, '--release-id', env.DC_RELEASE_ID, '--scanner-type', scanner, '--ref-branch', env.DC_REF_NAME || '', '--commit-sha', env.DC_COMMIT_SHA || ''] });
  const external = JSON.parse(env.DC_EXTERNAL_ARTIFACTS || '[]');
  const addSbom = (file, required) => targets.push({ name: 'SBOM', file, required, args: ['sbom', 'upload', '--file', file, '--release-id', env.DC_RELEASE_ID, '--commit-sha', env.DC_COMMIT_SHA || '', '--ref-branch', env.DC_REF_NAME || ''] });
  if (env.DC_RUN_CODEQL === 'true') addSarif('CodeQL SARIF', env.DC_CODEQL_SCAN_ZIP, 'CODEQL', false);
  if (env.DC_RUN_GITLEAKS === 'true') addSarif('Gitleaks SARIF', env.DC_GITLEAKS_SCAN_ZIP, 'GITLEAKS', false);
  if (env.DC_SKIP_SARIF !== 'true') {
    for (const artifact of external.filter((item) => item.type !== 'SBOM')) addSarif(`External ${artifact.type} SARIF`, artifact.file, artifact.type, true);
  }
  if (env.DC_RUN_SBOM === 'true') addSbom(env.DC_SBOM_OUTPUT, false);
  if (env.DC_SKIP_SBOM !== 'true') {
    for (const artifact of external.filter((item) => item.type === 'SBOM')) addSbom(artifact.file, true);
  }
  return targets;
}

function uploadTarget({ name, file, args, required }) {
  console.log(`--- Upload: ${name} ---`);
  if (required) {
    try { externalFile(file || '', name); } catch (error) { console.error(error.message); return false; }
  } else if (!fs.existsSync(file)) { console.log(`No ${name} file found; skipping.`); return true; }
  const result = run('smctl', args, { allowFailure: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) { console.error(`${name} upload: FAILED`); return false; }
  console.log(`${name} upload: OK`);
  return true;
}

function upload() {
  const env = process.env;
  if (env.DC_SKIP_SARIF === 'true' && env.DC_SKIP_SBOM === 'true') {
    console.log('SARIF and SBOM uploads skipped.');
    return;
  }
  if (!env.DC_RELEASE_ID) throw new Error('No RELEASE_ID available; cannot upload.');
  const results = uploadTargets(env).map(uploadTarget);
  const failed = results.some((result) => !result);
  if (failed) throw new Error('One or more uploads failed.');
  console.log(`All scans and SBOM uploaded to release ${env.DC_RELEASE_ID}.`);
}

module.exports = { startScans, resolveLanguages, waitScans, packageSarifs, upload };