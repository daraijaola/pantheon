import { createServer, request } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from './fixtures/rpc.mjs';
import { basket, site, stats, trials } from './fixtures/data.mjs';
import { uploaded } from './fixtures/uploaded.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = 'http://127.0.0.1:4174';
const unexpected = [];
const denied = [];
const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('content-type', 'application/json');
  if (/^https?:\/\//.test(req.url)) {
    denied.push(req.url);
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: 'External browser requests are blocked' }));
  }
  if (req.method === 'OPTIONS') return res.end();
  const url = new URL(req.url, service);
  try {
    let body;
    if (url.pathname === '/rpc') {
      let text = '';
      for await (const chunk of req) text += chunk;
      const data = JSON.parse(text);
      body = Array.isArray(data) ? await Promise.all(data.map(rpc)) : await rpc(data);
    } else if (url.pathname === '/__unexpected') body = unexpected;
    else if (url.pathname === '/__denied') body = denied;
    else if (url.pathname === '/health') body = { ...stats, newestUpdateMs: 1794000000000 };
    else if (url.pathname === '/stats' || url.pathname === '/passport/stats') body = stats;
    else if (url.pathname === '/basket') body = basket;
    else if (url.pathname === '/receipts') body = { receipts: [], next: null };
    else if (url.pathname === '/trials/current') body = trials(url.searchParams.get('voter'));
    else if (url.pathname === '/passport/tiers') body = { tiers: [] };
    else if (/^\/wallets\/0x[0-9a-f]{40}\//i.test(url.pathname) && Object.hasOwn(uploaded, url.pathname.split('/').slice(3).join('/'))) body = uploaded[url.pathname.split('/').slice(3).join('/')];
    else throw new Error(`Unconfigured fixture HTTP ${req.method} ${url.pathname}`);
    res.end(JSON.stringify(body));
  } catch (error) {
    unexpected.push(error.message);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.on('connect', (req, socket) => {
  denied.push(req.url);
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4174, '127.0.0.1', resolve); });
const runtime = path.join(root, 'e2e/.runtime');
await mkdir(runtime, { recursive: true });
await writeFile(path.join(runtime, 'site.json'), JSON.stringify(site));
const key = path.join(runtime, 'localhost.key');
const cert = path.join(runtime, 'localhost.crt');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const secureServer = createSecureServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
  const upstream = request({ hostname: '127.0.0.1', port: req.url === '/rpc' ? 4174 : 4175, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
await new Promise((resolve, reject) => { secureServer.once('error', reject); secureServer.listen(4176, '127.0.0.1', resolve); });
const env = {
  ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next',
  NEXT_PUBLIC_DEPLOYMENT: 'elysium-testnet', NEXT_PUBLIC_RPC_URL: 'https://127.0.0.1:4176/rpc',
  NEXT_PUBLIC_WC_PROJECT_ID: '', NEXT_PUBLIC_DEV_WALLET: '',
  INDEXER_API: service, TRIALS_API: service, PASSPORT_API: service,
  DELPHI_SITE_JSON: path.join(runtime, 'site.json'), DELPHI_HEALTH_URL: `${service}/health`,
  ANTHROPIC_API_KEY: '', XAI_API_KEY: '',
  SESSION_SECRET: 'e2e-only-session-secret-not-for-deployment', AUTH_ORIGIN: 'http://127.0.0.1:4173',
  UPLOADED_API: service,
};
let child;
let secureChild;
function next(args) { child = spawn(process.execPath, ['node_modules/next/dist/bin/next', ...args], { cwd: root, env, stdio: 'inherit' }); return child; }
function close() { secureChild?.kill('SIGTERM'); secureServer.close(); server.close(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child?.kill(signal); close(); });
const code = await new Promise(resolve => next(['build']).once('exit', resolve));
if (code !== 0) { close(); process.exit(code ?? 1); }
secureChild = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '4175'], { cwd: root, env: { ...env, AUTH_ORIGIN: 'https://127.0.0.1:4176' }, stdio: 'inherit' });
next(['start', '--hostname', '127.0.0.1', '--port', '4173']).once('exit', code => { close(); process.exit(code ?? 1); });
