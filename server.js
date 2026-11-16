'use strict';
/**
 * cloudzyro-dashboard — single-file Node.js status dashboard.
 *
 * Zero dependencies. Node >= 20.
 * - Health-checks every service every 60s (8s timeout).
 * - UP = any HTTP response arrived (even 400/404).
 * - DOWN = timeout / DNS failure / connection error only.
 * - State lives in memory and is also written to data/state.json.
 *
 * Secrets: NEVER in this repo. Optional env vars (server-side only,
 * never sent to the browser):
 *   PORT                 - Cloudzyro injects this; default 3000.
 *   TOKENLAB_API_KEY     - if set, the server pings the TokenLab API
 *                          to confirm the key is alive (key never leaves
 *                          the server).
 *   GITHUB_READ_TOKEN    - if set, the server fetches the private
 *                          muse-usage-widget usage.json (token never
 *                          leaves the server).
 *
 * Outbound proxy: this dev VM routes traffic through $https_proxy.
 * Node's global fetch honours it automatically (NODE_USE_ENV_PROXY=1
 * in the VM env) and trusts the egress MITM CA (NODE_EXTRA_CA_CERTS).
 * On Cloudzyro there is no proxy env and requests go direct.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const CHECK_INTERVAL_MS = 60_000;
const CHECK_TIMEOUT_MS = 8_000;
const STATE_FILE = path.join(__dirname, 'data', 'state.json');

// ---------------------------------------------------------------- services
const SERVICES = [
  { id: 'dsa', name: 'DSA 每日选股', group: 'InstaBox 服务', url: 'https://8000-agq5r5cqtrllaihmxkbnrk65wq.instabox.tech/api/health', expect: 200, note: 'InstaBox 机器闲置 30 分钟自动暂停，暂停时显示 DOWN，唤醒后恢复' },
  { id: 'radar', name: '资源雷达 freebie-radar', group: 'InstaBox 服务', url: 'https://8788-agq5r5cqtrllaihmxkbnrk65wq.instabox.tech/health', expect: 200, note: 'InstaBox 机器闲置 30 分钟自动暂停，暂停时显示 DOWN，唤醒后恢复' },
  { id: 'openwebui', name: 'Open WebUI', group: 'InstaBox 服务', url: 'https://3000-agq5r5cqtrllaihmxkbnrk65wq.instabox.tech/', expect: 200, note: 'InstaBox 机器闲置 30 分钟自动暂停，暂停时显示 DOWN，唤醒后恢复' },
  { id: 'simular', name: 'Simular 控制台', group: '其他', url: 'https://box.simular.ai/box', note: '任意 HTTP 响应即为可达' },
  { id: 'kaggle', name: 'Kaggle GPU', group: '算力（会话型）', kind: 'static', note: '会话型：无固定地址，不巡检；T4 x2，每周约 30 小时' },
  { id: 'colab', name: 'Google Colab', group: '算力（会话型）', kind: 'static', note: '会话型：无固定地址，不巡检；T4，单会话约 12 小时' },
  { id: 'cloudpc', name: '天翼云电脑', group: '云电脑', kind: 'static', note: '无公网 IP，公开访问待配隧道；4 核 8G，Windows Server 2022' },
];

const STATIC_QUOTAS = {
  tokenlab: {
    name: 'AMD TokenLab', total: 10, unit: '点', used: '~0', verified: '2026-11-15',
    expires: '2026-12-15',
    note: '每 Key 10 点、30 天有效；2026-12-08 起或余 ≤2 点可申领更多点数，2026-12-10 起可续期 15 天（只延有效期，不加点数）。',
  },
  openrouter: { name: 'OpenRouter', status: 'not-set-up', note: '尚未注册、无 Key。免费模型限 20 次/分钟，未充值每天 50 次。' },
  gemini: { name: 'Gemini 免费 API', model: 'gemini-4-hydrogen', note: '免费档可用，有速率限制；另有 AI Studio 网页版（免费，界面内使用不收费）。' },
};

// ---------------------------------------------------------------- state
// Ensure the data dir exists (git does not track empty dirs, so a fresh
// clone/deploy may not have it; saveState must not fail on first write).
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
let state = { checkedAt: null, results: {}, tokenlab: null, museUsage: null };
try {
  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  const saved = JSON.parse(raw);
  if (saved && typeof saved === 'object') state = { ...state, ...saved };
} catch { /* first run: no state yet */ }

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {
    console.error('state save failed:', e.message);
  }
}

// ------------------------------------------------------- proxy-aware GET
// Node's global fetch honours the proxy env vars when NODE_USE_ENV_PROXY=1
// (set in this VM's environment) and trusts the egress MITM CA via
// NODE_EXTRA_CA_CERTS. On Cloudzyro there is no proxy env and requests go
// direct. No manual CONNECT code needed — a hand-rolled tunnel was tried
// and fails against this MITM proxy (TLS handshake stalls after CONNECT
// 200); plain fetch works.

/**
 * GET a URL. Resolves with { status, body } for ANY HTTP response (even 400/404).
 * Rejects only on timeout / DNS failure / connection error.
 */
function httpGet(url, timeoutMs = CHECK_TIMEOUT_MS, extraHeaders = {}) {
  const started = Date.now();
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
    // Connection: close — the egress MITM proxy silently drops idle
    // keep-alive connections; reusing a dead pooled socket hangs until
    // the abort timeout. Fresh connection per check, no reuse.
    headers: { 'User-Agent': 'cloudzyro-dashboard/1.0', Connection: 'close', ...extraHeaders },
  }).then(async (r) => {
    let body = '';
    try { body = (await r.text()).slice(0, 65536); } catch { /* ignore */ }
    return { status: r.status, body, ms: Date.now() - started };
  });
}


function friendlyError(e) {
  const msg = String((e && e.message) || e);
  if (/abort|timeout|timed out/i.test(msg)) return '请求超时（8 秒无响应）';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return '域名解析失败';
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝';
  if (/ECONNRESET|EPIPE/i.test(msg)) return '连接被重置';
  return msg.replace(/^Error:\s*/, '').slice(0, 120);
}

// ------------------------------------------------------------- checks
async function checkService(svc) {
  const started = Date.now();
  try {
    const { status, ms } = await httpGet(svc.url);
    const ok = svc.expect ? status === svc.expect : true; // any response = up
    const prev = state.results[svc.id] || {};
    return {
      status: ok ? 'up' : 'unexpected',
      httpStatus: status, ms,
      lastOk: ok ? new Date().toISOString() : (prev.lastOk || null),
      lastError: ok ? null : `HTTP ${status}（期望 ${svc.expect}）`,
    };
  } catch (e) {
    const prev = state.results[svc.id] || {};
    return {
      status: 'down', httpStatus: null, ms: Date.now() - started,
      lastOk: prev.lastOk || null,
      lastError: friendlyError(e),
    };
  }
}

async function checkTokenLab() {
  const key = process.env.TOKENLAB_API_KEY;
  if (!key) return { live: false, reason: '未配置 Key（快照见下）' };
  try {
    const { status } = await httpGet('https://api.tokenlab.amd.com/v1/models',
      CHECK_TIMEOUT_MS, { Authorization: 'Bearer ' + key });
    if (status === 200) return { live: true, checkedAt: new Date().toISOString(), note: 'Key 有效，API 可达' };
    return { live: false, reason: 'API 返回 HTTP ' + status };
  } catch (e) {
    return { live: false, reason: friendlyError(e) };
  }
}

async function checkMuseUsage() {
  const token = process.env.GITHUB_READ_TOKEN;
  if (!token) return { configured: false, repo: 'https://github.com/xudong2010/muse-usage-widget' };
  try {
    const started = Date.now();
    const { status, body } = await httpGet(
      'https://raw.githubusercontent.com/xudong2010/muse-usage-widget/main/usage.json',
      CHECK_TIMEOUT_MS, { Authorization: 'Bearer ' + token });
    if (status !== 200) return { configured: true, error: 'GitHub 返回 HTTP ' + status };
    const data = JSON.parse(body);
    return { configured: true, checkedAt: new Date().toISOString(), ms: Date.now() - started, data };
  } catch (e) {
    return { configured: true, error: friendlyError(e) };
  }
}

let checking = false;
async function runChecks() {
  // Never overlap cycles: setInterval fires every 60s whether or not the
  // previous async cycle finished. Without this guard a slow cycle
  // (several 8s timeouts) piles a second cycle on top of it — 24
  // concurrent requests — which makes everything slower and can wedge
  // the quota checks that run last. Just skip the tick instead.
  if (checking) { console.log('check skipped: previous cycle still running'); return; }
  checking = true;
  try {
  const httpServices = SERVICES.filter((s) => s.kind !== 'static');
  // Stagger in batches of 3: parallel requests at once can choke a
  // shared egress proxy (and look like a burst to upstream CDNs).
  // Sequential-ish batches still finish in ~10s, well inside the 60s cycle.
  const BATCH = 3;
  for (let i = 0; i < httpServices.length; i += BATCH) {
    const batch = httpServices.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map((s) => checkService(s)));
    settled.forEach((r, j) => {
      if (r.status === 'fulfilled') state.results[batch[j].id] = r.value;
    });
  }
  state.tokenlab = await checkTokenLab();
  state.museUsage = await checkMuseUsage();
  state.checkedAt = new Date().toISOString();
  saveState();
  const up = httpServices.filter((s) => state.results[s.id]?.status === 'up').length;
  console.log(`[${state.checkedAt}] check done: ${up}/${httpServices.length} up`);
  } finally {
    checking = false;
  }
}

// ------------------------------------------------------------- API view
function daysUntil(dateStr) {
  const now = Date.now();
  const target = new Date(dateStr + 'T00:00:00+08:00').getTime();
  return Math.ceil((target - now) / 86_400_000);
}

function statusPayload() {
  return {
    updatedAt: state.checkedAt,
    nextCheckInSec: Math.max(0, Math.round((new Date(state.checkedAt).getTime() + CHECK_INTERVAL_MS - Date.now()) / 1000)),
    services: SERVICES.map((s) => ({
      id: s.id, name: s.name, group: s.group, url: s.url || null,
      kind: s.kind || 'http', note: s.note || '',
      ...(s.kind === 'static'
        ? { status: 'static' }
        : { ...(state.results[s.id] || { status: 'unknown', httpStatus: null, ms: null, lastOk: null, lastError: null }) }),
    })),
    quotas: {
      tokenlab: { ...STATIC_QUOTAS.tokenlab, daysLeft: daysUntil('2026-12-15'), live: state.tokenlab },
      openrouter: STATIC_QUOTAS.openrouter,
      gemini: STATIC_QUOTAS.gemini,
      muse: state.museUsage || { configured: false, repo: 'https://github.com/xudong2010/muse-usage-widget' },
    },
    countdowns: [
      { name: 'AMD TokenLab 到期', date: '2026-12-15', daysLeft: daysUntil('2026-12-15') },
    ],
  };
}

// ------------------------------------------------------------- HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(statusPayload()));
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, checkedAt: state.checkedAt }));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch {
      res.writeHead(500); return res.end('index.html missing');
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`dashboard listening on :${PORT}`);
  runChecks().catch((e) => console.error('initial check failed:', e.message));
  setInterval(() => runChecks().catch((e) => console.error('check failed:', e.message)), CHECK_INTERVAL_MS);
});
