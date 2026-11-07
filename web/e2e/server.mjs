import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from './fixtures/rpc.mjs';
import { basket, site, stats, trials } from './fixtures/data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = 'http://127.0.0.1:4174';
const unexpected = [];
const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('content-type', 'application/json');
  if (req.method === 'OPTIONS') return res.end();
  const url = new URL(req.url, service);
  try {
    let body;
    if (url.pathname === '/rpc') {
      let text = '';
      for await (const chunk of req) text += chunk;
      const data = JSON.parse(text);
      body = Array.isArray(data) ? data.map(rpc) : rpc(data);
    } else if (url.pathname === '/__unexpected') body = unexpected;
    else if (url.pathname === '/health') body = { ...stats, newestUpdateMs: 1794000000000 };
    else if (url.pathname === '/stats' || url.pathname === '/passport/stats') body = stats;
    else if (url.pathname === '/basket') body = basket;
    else if (url.pathname === '/receipts') body = { receipts: [], next: null };
    else if (url.pathname === '/trials/current') body = trials(url.searchParams.get('voter'));
    else if (url.pathname === '/passport/tiers') body = { tiers: [] };
    else throw new Error(`Unconfigured fixture HTTP ${req.method} ${url.pathname}`);
    res.end(JSON.stringify(body));
  } catch (error) {
    unexpected.push(error.message);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4174, '127.0.0.1', resolve); });
const runtime = path.join(root, 'e2e/.runtime');
await mkdir(runtime, { recursive: true });
await writeFile(path.join(runtime, 'site.json'), JSON.stringify(site));
const env = {
  ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next',
  NEXT_PUBLIC_DEPLOYMENT: 'elysium-testnet', NEXT_PUBLIC_RPC_URL: `${service}/rpc`,
  NEXT_PUBLIC_WC_PROJECT_ID: '', NEXT_PUBLIC_DEV_WALLET: '',
  INDEXER_API: service, TRIALS_API: service, PASSPORT_API: service,
  DELPHI_SITE_JSON: path.join(runtime, 'site.json'), DELPHI_HEALTH_URL: `${service}/health`,
  ANTHROPIC_API_KEY: '', XAI_API_KEY: '',
  SESSION_SECRET: 'e2e-only-session-secret-not-for-deployment', AUTH_ORIGIN: 'http://127.0.0.1:4173',
};
let child;
function next(args) { child = spawn(process.execPath, ['node_modules/next/dist/bin/next', ...args], { cwd: root, env, stdio: 'inherit' }); return child; }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child?.kill(signal); server.close(); });
const code = await new Promise(resolve => next(['build']).once('exit', resolve));
if (code !== 0) { server.close(); process.exit(code ?? 1); }
next(['start', '--hostname', '127.0.0.1', '--port', '4173']).once('exit', code => { server.close(); process.exit(code ?? 1); });
