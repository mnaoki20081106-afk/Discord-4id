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

/**
 * 仕分けのための再確認対象。
 * 「使える」は availableOlderThan より前に確認したもの、「使えない」は takenOlderThan より前のもの。
 * 確認が古い順。
 */
export async function dueRechecks(db, { availableOlderThan, takenOlderThan }, limit) {
  if (limit <= 0) return [];
  const { results } = await db
    .prepare(
      `SELECT name, len FROM found
       WHERE (status = 'available' AND checked_at < ?) OR (status = 'taken' AND checked_at < ?)
       ORDER BY checked_at LIMIT ?`,
    )
    .bind(availableOlderThan, takenOlderThan, limit)
    .all();
  return results || [];
}

// 数字・_・. を含まない、a-z だけの名前（緊急通知の対象の一つ）
const ALL_LETTERS_RE = /^[a-z]+$/;

/** 緊急通知（@everyone付き）にするか: 全部アルファベット、または3文字ID */
function isUrgent(name, len) {
  return ALL_LETTERS_RE.test(name) || len === 3;
}

/**
 * 確認結果を保存する。results: [{name, len, taken, seq?}]
 * - 空き → リストに追加 / 「使える」に更新
 * - 取られている → リストにあれば「使えない」に更新（リストにない名前は保存しない）
 * seq 付きの結果があればその文字数のカーソルを進める。
 *
 * @returns {Promise<{newlyAvailable: Array<{name: string, len: number, urgent: boolean}>}>}
 *   今回のバッチで新しく「使える」になった名前（既に使える状態だったものは含まない）。
 *   urgent: true は全部アルファベット or 3文字ID（@everyone付きで通知する対象）
 */
export async function applyResults(db, results, now, extraState = {}) {
  const state = await getState(db);
  const stmts = [];
  const maxSeq = {};

  const availableNames = [...new Set(results.filter((r) => !r.taken).map((r) => r.name))];
  const prevStatus = new Map();
  if (availableNames.length) {
    const placeholders = availableNames.map(() => '?').join(',');
    const { results: rows } = await db.prepare(`SELECT name, status FROM found WHERE name IN (${placeholders})`).bind(...availableNames).all();
    for (const row of rows || []) prevStatus.set(row.name, row.status);
  }
  const newlyAvailable = new Map(); // name -> {name, len, urgent}

  for (const r of results) {
    const status = r.taken ? 'taken' : 'available';
    if (r.taken) {
      stmts.push(
        db
          .prepare(
            `UPDATE found SET checked_at = ?2,
               changed_at = CASE WHEN status = 'taken' THEN changed_at ELSE ?2 END,
               status = 'taken'
             WHERE name = ?1`,
          )
          .bind(r.name, now),
      );
    } else {
      stmts.push(
        db
          .prepare(
            `INSERT INTO found (name, len, status, found_at, checked_at, changed_at) VALUES (?1, ?2, ?3, ?4, ?4, ?4)
             ON CONFLICT(name) DO UPDATE SET checked_at = excluded.checked_at,
               changed_at = CASE WHEN found.status = excluded.status THEN found.changed_at ELSE excluded.checked_at END,
               status = excluded.status`,
          )
          .bind(r.name, r.len, status, now),
      );
      if (prevStatus.get(r.name) !== 'available') {
        newlyAvailable.set(r.name, { name: r.name, len: r.len, urgent: isUrgent(r.name, r.len) });
      }
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

  return { newlyAvailable: [...newlyAvailable.values()] };
}

/** status: 'available' | 'taken' | null(すべて) */
export async function listFound(db, { status = 'available', len = null, limit = 20 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (len) {
    where.push('len = ?');
    params.push(len);
  }
  const sql = `SELECT name, len, status, found_at, checked_at, changed_at FROM found
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE status WHEN 'available' THEN 0 ELSE 1 END, changed_at DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...params, limit).all();
  return results || [];
}

/** { available: n, taken: n } */
export async function countByStatus(db) {
  const { results } = await db.prepare('SELECT status, COUNT(*) AS c FROM found GROUP BY status').all();
  const out = { available: 0, taken: 0 };
  for (const r of results || []) out[r.status] = Number(r.c);
  return out;
}
