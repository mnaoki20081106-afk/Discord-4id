import { checkUsername } from './checker.js';
import { isValidUsername, seqToName, totalFor } from './generator.js';
import { applyResults, dueRechecks, getState, seqOf } from './store.js';

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/** 次に確認する名前を決める（周回数が一番少ない文字数を優先、同じなら SCAN_LENGTHS の順） */
export function planBatch(state, cfg, limit) {
  let best = null;
  for (const len of cfg.lengths) {
    const total = totalFor(len, cfg.charset);
    const pass = Math.floor(seqOf(state, len) / total);
    if (!best || pass < best.pass) best = { len, pass };
  }
  const { len } = best;
  let seq = seqOf(state, len);
  const items = [];
  for (let guard = 0; items.length < limit && guard < limit * 20; guard++, seq++) {
    const name = seqToName(seq, len, cfg.charset);
    if (isValidUsername(name)) items.push({ name, len, seq });
  }
  return { len, items };
}

/** 再確認分＋新規分をまとめて作る（外部スキャナーにも渡す） */
export async function buildQueue(db, cfg, limit, now) {
  const state = await getState(db);
  const rechecks = await dueRechecks(
    db,
    { availableOlderThan: now - cfg.recheckMs, takenOlderThan: now - cfg.takenRecheckMs },
    Math.ceil(limit / 4),
  );
  const plan = planBatch(state, cfg, limit - rechecks.length);
  return { state, queue: [...rechecks.map((r) => ({ name: r.name, len: r.len })), ...plan.items] };
}

/** Worker の cron から呼ばれるスキャン本体 */
export async function runScan(db, cfg, { fetchImpl = fetch, sleep = sleepDefault, now = Date.now } = {}) {
  const start = now();
  const state = await getState(db);
  const cooldown = Number(state.cooldown_until || 0);
  if (cooldown > start) return { skipped: 'cooldown', until: cooldown };

  const { queue } = await buildQueue(db, cfg, cfg.batch, start);
  const results = [];
  const extra = { last_scan_at: start };
  for (let i = 0; i < queue.length; i++) {
    if (i > 0 && cfg.delayMs) await sleep(cfg.delayMs);
    const item = queue[i];
    const r = await checkUsername(item.name, { fetchImpl });
    if (r.status === 'ratelimited') {
      extra.cooldown_until = now() + r.retryAfterMs;
      extra.cooldown_reason = 'ratelimit';
      break;
    }
    if (r.status === 'error') {
      // 403 等（ブロック）なら 5 分休む。状態は /id で見られるよう保存
      extra.last_error = `${new Date(now()).toISOString()} HTTP ${r.code} ${r.message}`.slice(0, 300);
      extra.cooldown_until = now() + 5 * 60_000;
      extra.cooldown_reason = 'error';
      break;
    }
    results.push({ ...item, taken: r.status === 'taken' });
  }
  if (results.length) extra.last_ok_at = now();
  await applyResults(db, results, now(), extra);
  return { checked: results.length, available: results.filter((r) => !r.taken).map((r) => r.name), ...extra };
}
