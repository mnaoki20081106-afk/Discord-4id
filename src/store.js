// D1 へのアクセス

export async function getState(db) {
  const { results } = await db.prepare('SELECT key, value FROM state').all();
  const out = {};
  for (const r of results || []) out[r.key] = r.value;
  return out;
}

function setStateStmt(db, key, value) {
  return db
    .prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value));
}

export async function setState(db, entries) {
  const stmts = Object.entries(entries).map(([k, v]) => setStateStmt(db, k, v));
  if (stmts.length) await db.batch(stmts);
}

export function seqOf(state, len) {
  return Number(state[`seq:${len}`] || 0);
}

/** 再確認が必要な「空き」名 */
export async function dueRechecks(db, olderThan, limit) {
  if (limit <= 0) return [];
  const { results } = await db
    .prepare('SELECT name, len FROM available WHERE checked_at < ? ORDER BY checked_at LIMIT ?')
    .bind(olderThan, limit)
    .all();
  return results || [];
}

/**
 * 確認結果を保存する。results: [{name, len, taken, seq?}]
 * seq 付きの結果があればその文字数のカーソルを進める。
 */
export async function applyResults(db, results, now, extraState = {}) {
  const state = await getState(db);
  const stmts = [];
  const maxSeq = {};
  for (const r of results) {
    if (r.taken) {
      stmts.push(db.prepare('DELETE FROM available WHERE name = ?').bind(r.name));
    } else {
      stmts.push(
        db
          .prepare(
            `INSERT INTO available (name, len, found_at, checked_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET checked_at = excluded.checked_at`,
          )
          .bind(r.name, r.len, now, now),
      );
    }
    if (Number.isInteger(r.seq)) maxSeq[r.len] = Math.max(maxSeq[r.len] ?? -1, r.seq);
  }
  for (const [len, s] of Object.entries(maxSeq)) {
    if (s + 1 > seqOf(state, len)) stmts.push(setStateStmt(db, `seq:${len}`, s + 1));
  }
  const checked = Number(state.checked_total || 0) + results.length;
  stmts.push(setStateStmt(db, 'checked_total', checked));
  for (const [k, v] of Object.entries(extraState)) stmts.push(setStateStmt(db, k, v));
  await db.batch(stmts);
}

export async function listAvailable(db, { len = null, limit = 20, random = false } = {}) {
  const order = random ? 'RANDOM()' : 'checked_at DESC';
  const q = len
    ? db.prepare(`SELECT name, len, found_at, checked_at FROM available WHERE len = ? ORDER BY ${order} LIMIT ?`).bind(len, limit)
    : db.prepare(`SELECT name, len, found_at, checked_at FROM available ORDER BY len, ${order} LIMIT ?`).bind(limit);
  const { results } = await q.all();
  return results || [];
}

export async function countByLen(db) {
  const { results } = await db.prepare('SELECT len, COUNT(*) AS c FROM available GROUP BY len').all();
  const out = {};
  for (const r of results || []) out[r.len] = Number(r.c);
  return out;
}
