'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

function httpsUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\x00-\x20\x7f\\]/.test(value)) throw new Error('External artifact URL must be a valid HTTPS URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('External artifact URL must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('External artifact URL must use HTTPS and must not contain credentials.');
  }
  return url.href;
}

function parseExternal(raw, skipSbom, skipSarif) {
  let values;
  try { values = JSON.parse(raw || '[]'); } catch { throw new Error('external-paths must be a JSON array of SCANNER_TYPE:URL strings.'); }
  if (!Array.isArray(values)) throw new Error('external-paths must be a JSON array of SCANNER_TYPE:URL strings.');
  const entries = [];
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('Each external-paths entry must be a SCANNER_TYPE:URL string.');
    const separator = value.indexOf(':');
    const type = value.slice(0, separator).trim().toUpperCase();
    if (separator <= 0 || !/^[A-Z][A-Z0-9_]*$/.test(type)) throw new Error('Each external-paths entry must have a valid scanner type and URL.');
    if ((type === 'SBOM' && skipSbom) || (type !== 'SBOM' && skipSarif)) continue;
    entries.push({ type, url: httpsUrl(value.slice(separator + 1)) });
  }
  return entries;
}

function request(url, index) {
  return new Promise((resolve, reject) => {
    const operation = https.get(url, { signal: AbortSignal.timeout(120000) }, resolve);
    operation.on('error', () => reject(new Error(`External artifact ${index} download failed.`)));
  });
}

function redirectUrl(location, current, origin, index) {
  let next;
  try { next = httpsUrl(new URL(location, current).href); } catch { throw new Error(`External artifact ${index} has an invalid redirect.`); }
  if (new URL(next).origin !== origin) throw new Error(`External artifact ${index} redirects to a different origin.`);
  return next;
}

async function downloadFile(entry, destination, index) {
  const origin = new URL(entry.url).origin;
  let url = entry.url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await request(url, index);
    const status = response.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      response.resume();
      if (!response.headers.location || redirects === 5) throw new Error(`External artifact ${index} has an invalid redirect.`);
      url = redirectUrl(response.headers.location, url, origin, index);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`External artifact ${index} download failed (HTTP ${status}).`);
    }
    try { await pipeline(response, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })); }
    catch { throw new Error(`External artifact ${index} download failed.`); }
    if (fs.statSync(destination).size === 0) throw new Error(`External artifact ${index} is empty.`);
    return;
  }
}

async function downloadExternal(entries, runnerTemp) {
  if (!entries.length) return [];
  const directory = fs.mkdtempSync(path.join(runnerTemp, 'dc-external-'));
  const files = [];
  try {
    for (const [index, entry] of entries.entries()) {
      const file = path.join(directory, `${index + 1}-${entry.type}${entry.type === 'SBOM' ? '.json' : '.zip'}`);
      await downloadFile(entry, file, index + 1);
      files.push({ type: entry.type, file });
      console.log(`Downloaded external ${entry.type} artifact ${index + 1}.`);
    }
    return files;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { httpsUrl, parseExternal, downloadExternal };