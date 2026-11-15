// 無料プロキシ群から Discord の非認証確認API (unique-username/username-attempt-unauthed) を並列に叩くスキャナー。
//
// 「まず全部検証してからスキャン」という段階分けはしない。検証班とスキャン班を同じ締切(duration_sec)の中で
// 同時に走らせる1本のパイプラインにする:
//   検証班: 集めた候補(既定で全件、~55万件)を手当たり次第チェックし、生きてたらプールに積む
//   スキャン班: プールから生存プロキシを取り出し、死ぬ(3連続失敗 or 締切)までそれで撃ち続ける。
//              死んだら即座に捨てて、プールから次を取り出す
// これで候補がどれだけ多くても最初の1本が生きた瞬間からスキャンが始まり、生存プロキシが尽きる・死ぬたびに
// 即座に次へ差し替わる。
//   WORKER_URL=https://xxx.workers.dev SCAN_SECRET=... node scripts/proxy-scan.js
import { checkUsername, paceMs } from '../src/checker.js';
import { fetchProxyCandidates, makeProxyFetch, proxyKey, tcpProbe, withDeadline } from '../src/proxy-pool.js';

const base = (process.env.WORKER_URL || '').replace(/\/$/, '');
const secret = process.env.SCAN_SECRET;
if (!base || !secret) {
  console.error('WORKER_URL と SCAN_SECRET を指定してください');
  process.exit(1);
}

const durationMs = Number(process.env.SCAN_DURATION_SEC || 270) * 1000;
const heartbeatMs = Number(process.env.PROXY_HEARTBEAT_MS || 10000);
const validateWorkers = Number(process.env.PROXY_VALIDATE_CONCURRENCY || 800); // 検証班の人数
const maxScanWorkers = Number(process.env.PROXY_MAX_WORKERS || 300); // スキャン班の人数（生存プロキシの同時使用上限）
const candidateLimitEnv = Number(process.env.PROXY_CANDIDATE_LIMIT || 0);
const candidateLimit = candidateLimitEnv > 0 ? candidateLimitEnv : Infinity; // 未指定なら集めた全件を使う
const validateTimeoutMs = Number(process.env.PROXY_VALIDATE_TIMEOUT_MS || 4000); // 1本あたりの到達性チェック
const tcpProbeTimeoutMs = Number(process.env.PROXY_TCP_TIMEOUT_MS || 2000); // 本番チェック前のポート疎通だけの軽量フィルタ
const minDelayMs = Number(process.env.SCAN_MIN_DELAY_MS || 400);
const probeName = process.env.PROXY_PROBE_NAME || 'discord'; // 既に取られている名前。JSONが返れば抜けてる証拠
const batchFetchSize = Number(process.env.SCAN_BATCH_FETCH || 500); // Workerから一度に引く件数
const reportEveryMs = Number(process.env.SCAN_REPORT_INTERVAL_MS || 15000);
const maxFailsPerProxy = Number(process.env.PROXY_MAX_FAILS || 3);

const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// どこかで何かがハング（abortが効かないソケット等）しても絶対に終わらせるための最終防衛線
const watchdogMs = durationMs + 180000;
setTimeout(() => {
  console.error(`[proxy-scan] watchdog: ${(watchdogMs / 1000).toFixed(0)}秒経っても終わらないので強制終了`);
  process.exit(1);
}, watchdogMs);

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

async function main() {
  const started = Date.now();
  const deadline = started + durationMs;

  let allCandidates = await fetchProxyCandidates();
  console.log(`[proxy-scan] 候補合計: ${allCandidates.length}`);
  if (!allCandidates.length) {
    console.error('プロキシ候補が1件も取得できなかった。中止。');
    process.exit(1);
  }
  // 手当たり次第の順で検証するので、特定ソース偏重を避けるためシャッフルしておく
  for (let i = allCandidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allCandidates[i], allCandidates[j]] = [allCandidates[j], allCandidates[i]];
  }
  if (Number.isFinite(candidateLimit)) allCandidates = allCandidates.slice(0, candidateLimit);
  console.log(
    `[proxy-scan] 検証キュー: ${allCandidates.length}件を検証班${validateWorkers}人・スキャン班最大${maxScanWorkers}本で並走`,
  );

  let nextIdx = 0;
  const nextCandidate = () => (nextIdx < allCandidates.length ? allCandidates[nextIdx++] : null);

  const alivePool = []; // 検証班が見つけた生存プロキシの fetchImpl（.proxy と .close() 付き）
  let validated = 0;
  let aliveFound = 0;
  let deadOnArrival = 0;
  let portDead = 0; // TCPの時点で死んでた（Discordへの通信量を一切使わずに弾けた）
  let validatorsRunning = 0;

  async function validatorWorker() {
    validatorsRunning++;
    try {
      while (Date.now() < deadline) {
        const p = nextCandidate();
        if (!p) return;
        // 先に激安のTCP疎通だけ見る。候補の大半はここで死ぬので、Discordまでの
        // TLSハンドシェイク分の通信量を無駄にしないで済む
        const reachable = await tcpProbe(p, tcpProbeTimeoutMs);
        if (!reachable) {
          validated++;
          portDead++;
          continue;
        }
        const fx = makeProxyFetch(p, { requestTimeoutMs: validateTimeoutMs });
        fx.proxy = p;
        const r = await checkUsername(probeName, { fetchImpl: fx }).catch((e) => ({ status: 'error', message: String(e?.message || e) }));
        validated++;
        if (r.status === 'taken' || r.status === 'available' || r.status === 'ratelimited') {
          aliveFound++;
          alivePool.push(fx);
        } else {
          deadOnArrival++;
          fx.close();
        }
      }
    } finally {
      validatorsRunning--;
    }
  }

  const queue = new SharedQueue();
  const reporter = makeReporter();
  let total = 0;
  let limited = 0;
  let scanDead = 0;
  const found = [];
  const flushTimer = setInterval(() => reporter.flush(), reportEveryMs);

  async function useProxyUntilDead(fx) {
    let fails = 0;
    while (Date.now() < deadline) {
      await queue.ensure(maxScanWorkers * 2);
      const item = queue.next();
      if (!item) {
        if (queue.exhausted) return;
        await sleep(1500);
        continue;
      }
      const r = await checkUsername(item.name, { fetchImpl: fx }).catch((e) => ({ status: 'error', message: String(e?.message || e) }));
      if (r.status === 'ratelimited') {
        limited++;
        if (Date.now() + r.retryAfterMs >= deadline) return;
        await sleep(r.retryAfterMs);
        continue;
      }
      if (r.status === 'error') {
        fails++;
        if (fails >= maxFailsPerProxy) {
          scanDead++;
          return; // このプロキシは容赦なく見限る。呼び出し元が捨てて次に差し替える
        }
        await sleep(1000);
        continue;
      }
      fails = 0;
      total++;
      reporter.push({ ...item, taken: r.status === 'taken' });
      if (r.status === 'available') {
        found.push(item.name);
        console.log(`✅ available: ${item.name} (via ${proxyKey(fx.proxy)})`);
      }
      if (total <= 10 || total % 50 === 0) console.log(`#${total} ${item.name} ${r.status} | ${fmtRate(r.rate)}`);
      await sleep(paceMs(r.rate, minDelayMs));
    }
  }

  async function scanWorker() {
    while (Date.now() < deadline) {
      const fx = alivePool.shift();
      if (!fx) {
        // 検証班が全滅していて、かつ候補も尽きていたら、もう新しい生存プロキシは二度と来ない
        if (validatorsRunning === 0 && nextIdx >= allCandidates.length) return;
        await sleep(500);
        continue;
      }
      await useProxyUntilDead(fx);
      fx.close();
    }
  }

  const validators = Array.from({ length: Math.max(1, Math.min(validateWorkers, allCandidates.length)) }, () => validatorWorker());
  const scanners = Array.from({ length: Math.max(1, maxScanWorkers) }, () => scanWorker());

  const hb = setInterval(() => {
    const remain = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    console.log(
      `[proxy-scan] heartbeat: 検証${validated}/${allCandidates.length}(生存${aliveFound}/ポート死${portDead}/DOA${deadOnArrival}) | ` +
        `スキャン済${total} 429=${limited} 死亡=${scanDead} | プール待機${alivePool.length}本 | 残り${remain}秒`,
    );
  }, heartbeatMs);

  // 止まったプロキシが abort を無視してハングしても、この締切で強制的に次へ進む
  await withDeadline(Promise.all([...validators, ...scanners]), durationMs + 30000, () =>
    console.log('[proxy-scan] 締切+30秒でも終わり切らないワーカーがいるので打ち切る'),
  );
  clearInterval(hb);
  clearInterval(flushTimer);
  await reporter.flush();

  const mins = (Date.now() - started) / 60000;
  console.log(
    `done. checked=${total} in ${mins.toFixed(1)}min (${(total / Math.max(mins, 0.01)).toFixed(1)}/min) ` +
      `validated=${validated}/${allCandidates.length} alive_found=${aliveFound} port_dead=${portDead} dead_on_arrival=${deadOnArrival} ` +
      `429s=${limited} dead_in_scan=${scanDead} found=${found.length} ${found.join(', ')}`,
  );
  // ProxyAgent のソケットが残ってイベントループが閉じない場合があるので明示的に終了する
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
