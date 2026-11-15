// 外部スキャナー（GitHub Actions など）。Worker から次の名前を受け取り、確認して結果を返す。
//   WORKER_URL=https://xxx.workers.dev SCAN_SECRET=... node scripts/external-scan.js
// Discord のレート制限ヘッダー (x-ratelimit-remaining / reset-after) を見て、上限を超えないペースで送る。
import { checkUsername, paceMs } from '../src/checker.js';

const base = (process.env.WORKER_URL || '').replace(/\/$/, '');
const secret = process.env.SCAN_SECRET;
const durationMs = Number(process.env.SCAN_DURATION_SEC || 270) * 1000;
const batchSize = Number(process.env.SCAN_BATCH || 40);
const minDelayMs = Number(process.env.SCAN_MIN_DELAY_MS || 1000);
if (!base || !secret) {
  console.error('WORKER_URL と SCAN_SECRET を指定してください');
  process.exit(1);
}
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const deadline = started + durationMs;
const fmtRate = (r) =>
  r ? `limit=${r.limit} remaining=${r.remaining} reset_after=${r.resetAfter}s bucket=${r.bucket} scope=${r.scope ?? '-'}` : '-';

async function report(results, error) {
  if (!results.length && !error) return;
  const res = await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ results, error }) });
  console.log(`report: ${res.status} ${await res.text()}`);
}

let total = 0;
let limited = 0;
const found = [];
outer: while (Date.now() < deadline) {
  const res = await fetch(`${base}/api/batch?limit=${batchSize}`, { headers });
  if (!res.ok) {
    console.error(`batch failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { items } = await res.json();
  if (!items.length) break;
  const results = [];
  for (let i = 0; i < items.length; ) {
    const item = items[i];
    if (Date.now() >= deadline) break;
    const r = await checkUsername(item.name);
    if (r.status === 'ratelimited') {
      limited++;
      console.log(`429 after ${total} checks: wait ${Math.round(r.retryAfterMs / 1000)}s | ${fmtRate(r.rate)} | body=${r.body}`);
      await report(results.splice(0));
      if (Date.now() + r.retryAfterMs >= deadline) break outer;
      await sleep(r.retryAfterMs);
      continue; // 同じ名前をもう一度
    }
    if (r.status === 'error') {
      console.error(`error: HTTP ${r.code} ${r.message}`);
      await report(results, `HTTP ${r.code} ${r.message}`);
      break outer;
    }
    results.push({ ...item, taken: r.status === 'taken' });
    i++;
    total++;
    if (r.status === 'available') {
      found.push(item.name);
      console.log(`✅ available: ${item.name}`);
    }
    const wait = paceMs(r.rate, minDelayMs);
    if (total <= 5 || total % 25 === 0 || r.rate?.remaining === 0) console.log(`#${total} ${item.name} ${r.status} | ${fmtRate(r.rate)} | next in ${wait}ms`);
    await sleep(wait);
  }
  await report(results);
}
const mins = (Date.now() - started) / 60000;
console.log(
  `done. checked=${total} in ${mins.toFixed(1)}min (${(total / Math.max(mins, 0.01)).toFixed(1)}/min) 429s=${limited} found=${found.length} ${found.join(', ')}`,
);
