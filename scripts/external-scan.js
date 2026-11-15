// 外部スキャナー（GitHub Actions など）。Worker から次の名前を受け取り、確認して結果を返す。
//   WORKER_URL=https://xxx.workers.dev SCAN_SECRET=... node scripts/external-scan.js
//   SCAN_DURATION_SEC（既定 270）秒だけ回して終了
import { checkUsername } from '../src/checker.js';

const base = (process.env.WORKER_URL || '').replace(/\/$/, '');
const secret = process.env.SCAN_SECRET;
const durationMs = Number(process.env.SCAN_DURATION_SEC || 270) * 1000;
const batchSize = Number(process.env.SCAN_BATCH || 40);
if (!base || !secret) {
  console.error('WORKER_URL と SCAN_SECRET を指定してください');
  process.exit(1);
}
const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + durationMs;

async function report(results, error) {
  if (!results.length && !error) return;
  const res = await fetch(`${base}/api/report`, { method: 'POST', headers, body: JSON.stringify({ results, error }) });
  console.log(`report: ${res.status} ${await res.text()}`);
}

let total = 0;
const found = [];
outer: while (Date.now() < deadline) {
  const res = await fetch(`${base}/api/batch?limit=${batchSize}`, { headers });
  if (!res.ok) {
    console.error(`batch failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { items, delayMs } = await res.json();
  if (!items.length) break;
  const results = [];
  for (let i = 0; i < items.length; ) {
    const item = items[i];
    if (Date.now() >= deadline) break;
    const r = await checkUsername(item.name);
    if (r.status === 'ratelimited') {
      console.log(`rate limited: wait ${r.retryAfterMs}ms`);
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
    await sleep(delayMs ?? 700);
  }
  await report(results);
}
console.log(`done. checked=${total} found=${found.length} ${found.join(', ')}`);
