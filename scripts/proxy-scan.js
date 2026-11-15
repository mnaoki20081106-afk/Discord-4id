// 無料プロキシ群から Discord の非認証確認API (unique-username/username-attempt-unauthed) を並列に叩くスキャナー。
// GitHub Actions の単一IPだと ~20件で数十分クールダウンが来るため、プロキシ1本=1IP=独立したレート制限バケット
// という前提で、生きてるプロキシの本数だけ同時並行で撃つ。各ワーカーは自分の429/retry_afterにだけ従う。
//   WORKER_URL=https://xxx.workers.dev SCAN_SECRET=... node scripts/proxy-scan.js
import { checkUsername, paceMs } from '../src/checker.js';
import { fetchProxyCandidates, makeProxyFetch, mapLimit, proxyKey } from '../src/proxy-pool.js';

const base = (process.env.WORKER_URL || '').replace(/\/$/, '');
const secret = process.env.SCAN_SECRET;
if (!base || !secret) {
  console.error('WORKER_URL と SCAN_SECRET を指定してください');
  process.exit(1);
}

const durationMs = Number(process.env.SCAN_DURATION_SEC || 270) * 1000;
const validateConcurrency = Number(process.env.PROXY_VALIDATE_CONCURRENCY || 250);
const candidateLimit = Number(process.env.PROXY_CANDIDATE_LIMIT || 6000); // ソース合計が数万〜十数万になるので検証前に間引く
const maxWorkers = Number(process.env.PROXY_MAX_WORKERS || 150);
const minDelayMs = Number(process.env.SCAN_MIN_DELAY_MS || 400);
const probeName = process.env.PROXY_PROBE_NAME || 'discord'; // 既に取られている名前。JSONが返れば抜けてる証拠
const batchFetchSize = Number(process.env.SCAN_BATCH_FETCH || 500); // Workerから一度に引く件数
const reportEveryMs = Number(process.env.SCAN_REPORT_INTERVAL_MS || 15000);
const maxFailsPerProxy = Number(process.env.PROXY_MAX_FAILS || 3);

const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmtRate = (r) =>
  r ? `limit=${r.limit} remaining=${r.remaining} reset_after=${r.resetAfter}s scope=${r.scope ?? '-'}` : '-';

// --- Worker からの名前供給（共有キュー。足りなくなったら1本だけ補充リクエストを出す） ---
class SharedQueue {
  constructor() {
    this.items = [];
    this.fetching = null;
    this.exhausted = false;
  }
  async ensure(minItems) {
    if (this.items.length >= minItems || this.exhausted) return;
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      try {
        const res = await fetch(`${base}/api/batch?limit=${batchFetchSize}`, { headers });
        if (!res.ok) {
          console.error(`[queue] batch failed: ${res.status} ${await res.text()}`);
          return;
        }
        const { items } = await res.json();
        if (!items.length) this.exhausted = true;
        this.items.push(...items);
      } catch (e) {
        console.error(`[queue] batch error: ${e.message}`);
      } finally {
        this.fetching = null;
      }
    })();
    return this.fetching;
  }
  next() {
    return this.items.shift();
  }
}

// --- 結果レポート（一定間隔でまとめて /api/report に送る。seqが進むので次のbatchが重複しにくくなる） ---
function makeReporter() {
  let buf = [];
  let lastError = null;
  async function flush() {
    if (!buf.length && !lastError) return;
    const payload = { results: buf.splice(0), error: lastError || undefined };
    lastError = null;
    try {
      const res = await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (!res.ok) console.error(`[report] ${res.status} ${await res.text()}`);
    } catch (e) {
      console.error(`[report] error: ${e.message}`);
    }
  }
  return {
    push(item) {
      buf.push(item);
    },
    setError(msg) {
      lastError = msg;
    },
    flush,
  };
}

async function validateProxies(candidates) {
  console.log(`[proxy-scan] ${candidates.length}件の候補をDiscord相手に検証中...`);
  const alive = [];
  await mapLimit(candidates, validateConcurrency, async (p) => {
    const fx = makeProxyFetch(p, { requestTimeoutMs: 6000 });
    const r = await checkUsername(probeName, { fetchImpl: fx }).catch((e) => ({ status: 'error', message: String(e?.message || e) }));
    if (r.status === 'taken' || r.status === 'available' || r.status === 'ratelimited') alive.push(p);
  });
  console.log(`[proxy-scan] 生存: ${alive.length}/${candidates.length}`);
  return alive;
}

async function main() {
  const started = Date.now();
  const deadline = started + durationMs;

  const allCandidates = await fetchProxyCandidates();
  console.log(`[proxy-scan] 候補合計: ${allCandidates.length}`);
  if (!allCandidates.length) {
    console.error('プロキシ候補が1件も取得できなかった。中止。');
    process.exit(1);
  }
  // ソースを全部合わせると数万〜十数万件になり得るので、検証が終わらない事態を避けるため
  // シャッフルして上限まで間引く（特定ソース偏重を避ける）
  for (let i = allCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allCandidates[i], allCandidates[j]] = [allCandidates[j], allCandidates[i]];
  }
  const candidates = allCandidates.slice(0, candidateLimit);
  console.log(`[proxy-scan] 検証対象: ${candidates.length}/${allCandidates.length}`);

  let alive = await validateProxies(candidates);
  const spares = alive.splice(maxWorkers);
  const pool = alive;
  if (!pool.length) {
    console.error('Discordまで抜けるプロキシが1本もなかった。中止。');
    process.exit(1);
  }
  console.log(`[proxy-scan] ${pool.length}本で並列開始（予備 ${spares.length}本）、制限時間 ${(durationMs / 60000).toFixed(1)}分`);

  const queue = new SharedQueue();
  const reporter = makeReporter();
  let total = 0;
  let limited = 0;
  let deadWorkers = 0;
  const found = [];
  const flushTimer = setInterval(() => reporter.flush(), reportEveryMs);

  async function runWorker(proxy) {
    const fetchImpl = makeProxyFetch(proxy);
    let fails = 0;
    while (Date.now() < deadline) {
      await queue.ensure(pool.length * 2);
      const item = queue.next();
      if (!item) {
        if (queue.exhausted) return;
        await sleep(1500);
        continue;
      }
      const r = await checkUsername(item.name, { fetchImpl }).catch((e) => ({ status: 'error', message: String(e?.message || e) }));
      if (r.status === 'ratelimited') {
        limited++;
        if (Date.now() + r.retryAfterMs >= deadline) return;
        await sleep(r.retryAfterMs);
        continue;
      }
      if (r.status === 'error') {
        fails++;
        if (fails >= maxFailsPerProxy) {
          deadWorkers++;
          return; // このプロキシは見限る（次のループで予備に差し替え）
        }
        await sleep(1000);
        continue;
      }
      fails = 0;
      total++;
      reporter.push({ ...item, taken: r.status === 'taken' });
      if (r.status === 'available') {
        found.push(item.name);
        console.log(`✅ available: ${item.name} (via ${proxyKey(proxy)})`);
      }
      if (total <= 10 || total % 100 === 0) console.log(`#${total} ${item.name} ${r.status} | ${fmtRate(r.rate)}`);
      await sleep(paceMs(r.rate, minDelayMs));
    }
  }

  // 死んだワーカーは予備プロキシで即座に補充する
  const running = new Set();
  function spawn(proxy) {
    const p = runWorker(proxy)
      .catch((e) => console.error(`[worker] 例外: ${e.message}`))
      .finally(async () => {
        running.delete(p);
        if (Date.now() < deadline && spares.length) spawn(spares.shift());
      });
    running.add(p);
    return p;
  }
  for (const proxy of pool) spawn(proxy);

  while (running.size && Date.now() < deadline) await sleep(1000);
  await Promise.allSettled([...running]);

  clearInterval(flushTimer);
  await reporter.flush();

  const mins = (Date.now() - started) / 60000;
  console.log(
    `done. checked=${total} in ${mins.toFixed(1)}min (${(total / Math.max(mins, 0.01)).toFixed(1)}/min) ` +
      `429s=${limited} dead_proxies=${deadWorkers} found=${found.length} ${found.join(', ')}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
