'use strict';

const { exportEnv, run, xargs } = require('./common');

function actorInfo() {
  const result = run('gh', ['api', `users/${process.env.GITHUB_ACTOR}`, '--jq', '{id:.id,node_id:.node_id}'], { allowFailure: true });
  if (result.status !== 0) return {};
  return JSON.parse(result.stdout || '{}');
}

function authorArgs(args, author) {
  if (author.id) args.push('--author-external-id', String(author.id));
  if (author.node_id) args.push('--author-external-global-id', String(author.node_id));
}

function createRelease() {
  const env = process.env;
  const provided = xargs(env.DC_INPUT_RELEASE_ID || '');
  if (provided) {
    exportEnv('DC_RELEASE_ID', provided);
    console.log(`Using provided dc-release-id '${provided}' and skipping release creation.`);
    return;
  }
  const withRelease = env.DC_INPUT_WITH_RELEASE === 'true';
  let name = env.DC_INPUT_NAME || '';
  let tagRaw = env.DC_INPUT_TAG || '';
  if (withRelease) {
    if ((!tagRaw || tagRaw === 'null') && (env.DC_REF || '').startsWith('refs/tags/')) tagRaw = env.DC_REF_NAME || '';
    if ((!name || name === 'null') && env.DC_REPO) name = env.DC_REPO;
    if (!name || name === 'null') throw new Error("Input 'name' is required when with-release is true.");
    if (!tagRaw || tagRaw === 'null') throw new Error("Input 'tag' is required when with-release is true (or trigger the workflow from a tag push).");
  }
  let tag = '';
  try { tag = xargs(tagRaw); } catch { tag = ''; }
  let scanName = withRelease ? `${name}-${tagRaw}` : name;
  if (!scanName || scanName === 'null') scanName = `${env.GITHUB_WORKFLOW || 'code-analysis-scan'}-${env.GITHUB_EVENT_NAME || 'manual'}`;
  scanName = scanName.replace(/\s+/g, '-').replace(/[/\\]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  if (!scanName) scanName = `code-analysis-${env.GITHUB_EVENT_NAME || 'manual'}`;
  const source = xargs((env.DC_INPUT_SOURCE || 'GITHUB_ACTION').toUpperCase()) || 'GITHUB_ACTION';
  if (!['GITHUB', 'GITHUB_ACTION'].includes(source)) throw new Error(`Invalid source: '${source}' (use GITHUB or GITHUB_ACTION).`);
  const args = ['release', 'create', '--vcs-repository-id', env.GITHUB_REPOSITORY_ID || '', '--repository-source', 'GITHUB', '--source', source, '--name', scanName, '--author', env.GITHUB_ACTOR || '', '--commit-sha', env.DC_COMMIT_SHA || '', '--source-branch', env.DC_REF_NAME || ''];
  if (withRelease) {
    let url, externalId, globalId, releasedAt, author;
    if (env.DC_INPUT_RELEASE_URL && env.DC_INPUT_RELEASE_NODE_ID && env.DC_INPUT_RELEASED_AT) {
      url = env.DC_INPUT_RELEASE_URL;
      globalId = env.DC_INPUT_RELEASE_NODE_ID.slice(0, 36);
      releasedAt = env.DC_INPUT_RELEASED_AT;
      author = actorInfo();
    } else {
      const result = run('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/releases/tags/${tag}`], { allowFailure: true });
      if (result.status !== 0) throw new Error(`Failed to fetch GitHub release metadata for tag '${tag}'.\ngh api error: ${result.stderr || result.stdout}`);
      const metadata = JSON.parse(result.stdout);
      if (!metadata.node_id || !metadata.html_url) throw new Error(`GitHub release metadata for tag '${tag}' is missing required fields (node_id, html_url).`);
      url = metadata.html_url;
      externalId = metadata.id;
      globalId = metadata.node_id.slice(0, 36);
      releasedAt = env.DC_INPUT_RELEASED_AT || metadata.published_at || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      author = metadata.author || {};
    }
    args.push('--release-type', 'RELEASED', '--status', 'RELEASED', '--tag', tag, '--release-url', url, '--external-global-id', globalId, '--released-at', releasedAt);
    if (externalId) args.push('--external-id', String(externalId));
    authorArgs(args, author);
  } else {
    const sha = env.GITHUB_SHA || '';
    const runId = env.GITHUB_RUN_ID || '0';
    args.push('--release-type', 'BUILD_ONLY', '--tag', sha.slice(0, 8), '--release-url', `https://github.com/${env.GITHUB_REPOSITORY}/commit/${sha}`, '--external-id', runId, '--external-global-id', `${sha.slice(0, 27)}-${runId.slice(0, 8)}`);
    authorArgs(args, actorInfo());
  }
  const result = run('smctl', args, { allowFailure: true });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  console.log(output.trimEnd());
  if (result.status !== 0) throw new Error(`smctl release create failed (exit ${result.status}).`);
  const match = /Release ID:[ \t\v\f\r]*([a-z0-9._-]+)/i.exec(output);
  const id = match?.[1];
  if (!id) throw new Error('Could not parse Release ID from smctl output.');
  exportEnv('DC_RELEASE_ID', String(id));
  console.log(`Release created: ${id}`);
}

module.exports = { createRelease };