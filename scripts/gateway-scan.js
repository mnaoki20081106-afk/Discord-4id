// 有料のローテーティング住宅プロキシ（DataImpulse等）経由でDiscordの非認証確認APIを撃つ。
// 無料プロキシ版(proxy-scan.js)と違って「候補を集めて検証する」工程が無い —
// ゲートウェイに投げれば常に生きてる住宅IPが割り当てられる。
// 1セッション(=1つの住宅IP)を GATEWAY_REQUESTS_PER_SESSION 回使ったら、429が来るのを待たずに
// 先回りで次のセッションIDへローテーションする（実測の「クリーンなIPは約20件で429」の閾値より
// 十分手前で自主的に切る）。429が来たらそのセッションは即座に見限って次のIPへ。
//   WORKER_URL=... SCAN_SECRET=... GATEWAY_LOGIN=... GATEWAY_PASSWORD=... node scripts/gateway-scan.js
import { checkUsername, paceMs } from '../src/checker.js';
import { makeGatewayFetch, randomSessionId } from '../src/gateway-proxy.js';

const base = (process.env.WORKER_URL || '').replace(/\/$/, '');
const secret = process.env.SCAN_SECRET;
const gwHost = process.env.GATEWAY_HOST || 'gw.dataimpulse.com';
const gwPort = Number(process.env.GATEWAY_PORT || 823);
const gwLogin = process.env.GATEWAY_LOGIN;
const gwPassword = process.env.GATEWAY_PASSWORD;
if (!base || !secret || !gwLogin || !gwPassword) {
  console.error('WORKER_URL, SCAN_SECRET, GATEWAY_LOGIN, GATEWAY_PASSWORD を指定してください');
  process.exit(1);
}

const durationMs = Number(process.env.SCAN_DURATION_SEC || 270) * 1000;
const heartbeatMs = Number(process.env.PROXY_HEARTBEAT_MS || 10000);
const concurrency = Number(process.env.GATEWAY_CONCURRENCY || 100); // 同時に使うセッション(住宅IP)の本数
const requestsPerSession = Number(process.env.GATEWAY_REQUESTS_PER_SESSION || 10); // 429を待たずに切るまでの回数
const requestTimeoutMs = Number(process.env.GATEWAY_REQUEST_TIMEOUT_MS || 8000);
const minDelayMs = Number(process.env.SCAN_MIN_DELAY_MS || 300);
const batchFetchSize = Number(process.env.SCAN_BATCH_FETCH || 500);
const reportEveryMs = Number(process.env.SCAN_REPORT_INTERVAL_MS || 15000);
const progressReportMs = Number(process.env.GATEWAY_PROGRESS_REPORT_MS || 300000); // Discordチャンネルへの進捗投稿間隔

const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// どこかで何かがハングしても絶対に終わらせるための最終防衛線
const watchdogMs = durationMs + 120000;
setTimeout(() => {
  console.error(`[gateway-scan] watchdog: ${(watchdogMs / 1000).toFixed(0)}秒経っても終わらないので強制終了`);
  process.exit(1);
}, watchdogMs);

const fmtRate = (r) =>
  r ? `limit=${r.limit} remaining=${r.remaining} reset_after=${r.resetAfter}s scope=${r.scope ?? '-'}` : '-';

/** Workerの /api/progress 経由で、/channel で設定したDiscordチャンネルに直接投稿する */
async function postProgress(message) {
  try {
    const res = await fetch(`${base}/api/progress`, { method: 'POST', headers, body: JSON.stringify({ message }) });
    if (!res.ok) console.error(`[progress] ${res.status} ${await res.text()}`);
  } catch (e) {
    console.error(`[progress] error: ${e.message}`);
  }
}

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

// --- 結果レポート（一定間隔でまとめて /api/report に送る） ---
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

async function main() {
  const started = Date.now();
  const deadline = started + durationMs;
  console.log(
    `[gateway-scan] ${gwHost}:${gwPort} 経由、同時${concurrency}セッション、` +
      `1セッションあたり最大${requestsPerSession}リクエストで先回りローテーション`,
  );

  const queue = new SharedQueue();
  const reporter = makeReporter();
  let total = 0;
  let limited = 0;
  let rotations = 0;
  let errors = 0;
  const found = [];
  const flushTimer = setInterval(() => reporter.flush(), reportEveryMs);

  async function sessionWorker(workerId) {
    while (Date.now() < deadline) {
      const sessionId = `w${workerId}-${randomSessionId()}`;
      const fx = makeGatewayFetch({ host: gwHost, port: gwPort, login: gwLogin, password: gwPassword, sessionId, requestTimeoutMs });
      let used = 0;
      try {
        while (Date.now() < deadline && used < requestsPerSession) {
          await queue.ensure(concurrency * 2);
          const item = queue.next();
          if (!item) {
            if (queue.exhausted) return;
            await sleep(1500);
            continue;
          }
          const r = await checkUsername(item.name, { fetchImpl: fx }).catch((e) => ({ status: 'error', message: String(e?.message || e) }));
          used++;
          if (r.status === 'ratelimited') {
            limited++;
            break; // このセッション(IP)は見限る。retry_after は待たず次のIPへ
          }
          if (r.status === 'error') {
            errors++;
            break;
          }
          total++;
          reporter.push({ ...item, taken: r.status === 'taken' });
          if (r.status === 'available') {
            found.push(item.name);
            console.log(`✅ available: ${item.name} (session ${sessionId})`);
          }
          if (total <= 10 || total % 100 === 0) console.log(`#${total} ${item.name} ${r.status} | ${fmtRate(r.rate)}`);
          await sleep(paceMs(r.rate, minDelayMs));
        }
      } finally {
        fx.close();
        rotations++;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, (_, i) => sessionWorker(i));

  const hb = setInterval(() => {
    const remain = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    console.log(
      `[gateway-scan] heartbeat: checked=${total} 429=${limited} errors=${errors} セッション切替=${rotations} | 残り${remain}秒`,
    );
  }, heartbeatMs);

  await postProgress(`▶️ スキャン開始（同時${concurrency}セッション、制限時間${(durationMs / 60000).toFixed(0)}分）`);
  const progressTimer = setInterval(() => {
    const remainMin = Math.max(0, Math.round((deadline - Date.now()) / 60000));
    postProgress(`📡 進捗: checked=${total} 429=${limited} errors=${errors} 見つけた=${found.length} | 残り${remainMin}分`);
  }, progressReportMs);

  await Promise.all(workers);
  clearInterval(hb);
  clearInterval(flushTimer);
  clearInterval(progressTimer);
  await reporter.flush();

  const mins = (Date.now() - started) / 60000;
  const summary =
    `done. checked=${total} in ${mins.toFixed(1)}min (${(total / Math.max(mins, 0.01)).toFixed(1)}/min) ` +
    `429s=${limited} errors=${errors} session_rotations=${rotations} found=${found.length} ${found.join(', ')}`;
  console.log(summary);
  await postProgress(`🏁 スキャン完了: checked=${total}件 (${mins.toFixed(1)}分) | 429=${limited} errors=${errors} 見つけた=${found.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
