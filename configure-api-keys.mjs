#!/usr/bin/env node
// Run from this file's project folder. No dependencies; Node 24.14+/26.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const args = process.argv.slice(2);
if (args.some(arg => !['--check', '--pinokio', '--all'].includes(arg))) {
  console.error('Usage: node configure-api-keys.mjs [--check] [--pinokio] [--all]');
  process.exit(2);
}
const root = path.dirname(fileURLToPath(import.meta.url));
const pinokio = args.includes('--pinokio');
const target = path.join(root, pinokio ? 'pinokio/ENVIRONMENT' : '.env.local');
const providers = [
  ['TOMTOM_API_KEY', 'TomTom traffic'],
  ['NCDOT_API_KEY', 'DriveNC events and cameras'],
  ['GOOGLE_MAPS_API_KEY', 'Google Maps (optional)'],
  ['CESIUM_ION_TOKEN', 'Cesium ion (optional)'],
  ...(args.includes('--all') ? [
    ['GOOGLE_MAPS_SERVER_API_KEY', 'Google server Places (optional)'],
    ['OPENAI_API_KEY', 'OpenAI voice (optional)'],
    ['AISSTREAM_API_KEY', 'AIS ships (optional)'],
    ['FIRMS_MAP_KEY', 'NASA FIRMS (optional)'],
    ['OPENSKY_CLIENT_ID', 'OpenSky client ID (optional)'],
    ['OPENSKY_CLIENT_SECRET', 'OpenSky client secret (optional)'],
  ] : []),
];
function readFile(file) {
  if (!fs.existsSync(file)) return '';
  const buffer = fs.readFileSync(file);
  return buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString('utf16le').replace(/^\uFEFF/, '') : buffer.toString('utf8').replace(/^\uFEFF/, '');
}
function effective() {
  const env = {}, owners = {};
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', ...(pinokio ? ['pinokio/ENVIRONMENT'] : [])]) {
    const values = parseEnv(readFile(path.join(root, name)));
    for (const [key, value] of Object.entries(values)) { env[key] = value; owners[key] = name; }
  }
  for (const [key] of providers) if (process.env[key] !== undefined) { env[key] = process.env[key]; owners[key] = 'shell environment'; }
  return { env, owners };
}
function hiddenPrompt(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Run this interactively in PowerShell, Command Prompt, or a Linux terminal.');
  process.stdout.write(`${label}: `);
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true); process.stdin.resume();
    const finish = (cancelled) => {
      process.stdin.off('data', onData); process.stdin.setRawMode(Boolean(wasRaw)); process.stdin.pause();
      process.stdout.write('\n'); cancelled ? reject(new Error('Cancelled; no changes saved.')) : resolve(value.trim());
    };
    const onData = data => {
      for (const character of data.toString('utf8')) {
        if (character === '\u0003') return finish(true);
        if (character === '\r' || character === '\n') return finish(false);
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && character <= '~') value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function check() {
  const {env, owners} = effective();
  for (const [key, label] of providers) console.log(`${label}: ${env[key] ? 'configured (' + owners[key] + ')' : 'not configured'}`);
  const key = env.TOMTOM_API_KEY;
  if (key) {
    // Test the exact vector-flow endpoint the app uses, not an unrelated Maps API.
    const z = 12, lon = -80.8431, lat = 35.2271;
    const x = Math.floor((lon + 180) / 360 * 2 ** z);
    const rad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * 2 ** z);
    const url = new URL(`https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf`);
    url.searchParams.set('key', key);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
      const bytes = await response.arrayBuffer();
      if (response.ok && bytes.byteLength) console.log('TomTom traffic tile: PASS — your key can access Charlotte traffic flow.');
      else {
        console.log(`TomTom traffic tile: HTTP ${response.status}.`);
        console.log(response.status === 401 || response.status === 403 ? 'Check the key, Traffic API product access, and any restrictions on server-side requests in the TomTom dashboard.' : response.status === 429 ? 'Rate limit or quota reached. Check your TomTom dashboard.' : 'The traffic service did not return a usable tile. Try again later.');
      }
    } catch { console.log('TomTom test could not connect within 15 seconds. Check DNS, firewall/proxy, and Internet access.'); }
  }
  try {
    const response = await fetch('http://127.0.0.1:4173/api/tomtom/status', { signal: AbortSignal.timeout(3000) });
    const status = await response.json();
    if (!response.ok || typeof status.hasKey !== 'boolean') throw new Error();
    console.log(`Running app: key ${status.hasKey ? 'detected' : 'NOT detected'}; daily tile usage ${status.dailyCount}/${status.budget}.`);
    if (!status.hasKey && key) console.log('Restart the server, then reload the browser: its current process has not loaded this key.');
    if (status.dailyCount >= status.budget) console.log('The app daily traffic-tile budget has been reached.');
  } catch { console.log('App status unavailable at port 4173. Start/restart the app, or check its actual URL if using Pinokio.'); }
  console.log('After saving: stop and restart the server, reload the browser, enable Street Traffic, select TomTom, and zoom into Charlotte streets.');
}
try {
  if (!args.includes('--check')) {
    console.log('Paste keys here; input is hidden. Enter keeps an existing key or skips that provider.');
    console.log(`Saving to ${path.relative(root, target)}; keys are not printed.`);
    let source = readFile(target);
    for (const [key, label] of providers) {
      const value = await hiddenPrompt(label);
      if (!value) continue;
      if (!/^[A-Za-z0-9._:+/=-]+$/.test(value)) throw new Error('Unexpected key characters; paste only the key. No changes saved.');
      const pattern = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=.*(?:\\r?\\n|$)`, 'gm');
      source = source.replace(pattern, '');
      source += `${source.endsWith('\n') || !source ? '' : '\n'}${key}=${value}\n`;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    // Older Pinokio launchers do not forward the added NCDOT field. Vite also
    // reads .env.local, so keep this one provider usable on those launchers.
    if (pinokio) {
      const driveKey = parseEnv(source).NCDOT_API_KEY;
      if (driveKey) {
        const localPath = path.join(root, '.env.local');
        let local = readFile(localPath).replace(/^[\t ]*(?:export[\t ]+)?NCDOT_API_KEY[\t ]*=.*(?:\r?\n|$)/gm, '');
        local += `${local.endsWith('\n') || !local ? '' : '\n'}NCDOT_API_KEY=${driveKey}\n`;
        fs.writeFileSync(localPath, local, { mode: 0o600 }); fs.chmodSync(localPath, 0o600);
      }
    }
    console.log('Configuration saved. Restart the app to load the keys.');
    const {owners} = effective();
    for (const [key] of providers) if (owners[key] && owners[key] !== path.relative(root, target).split(path.sep).join('/')) console.log(`${key} is overridden by ${owners[key]}; update or remove that duplicate to use the saved value.`);
  }
  await check();
} catch { console.error('Setup stopped. Check the terminal mode, key format, Node version, and file permissions.'); process.exitCode = 1; }
