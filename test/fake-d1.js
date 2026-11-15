// テスト用: node:sqlite で D1 の最低限の API を再現
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class Stmt {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...p) {
    return new Stmt(this.db, this.sql, p);
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async run() {
    this.db.prepare(this.sql).run(...this.params);
    return { success: true };
  }
}

export function createFakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        for (const s of stmts) await s.run();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return [];
    },
  };
}

/** Discord の確認 API のモック。takenSet にない名前は空き扱い */
export function mockDiscord({ available = new Set(), rateLimitAfter = Infinity, status = 200 } = {}) {
  let calls = 0;
  const fn = async (_url, init) => {
    calls++;
    if (calls > rateLimitAfter) return new Response(JSON.stringify({ retry_after: 30 }), { status: 429 });
    if (status !== 200) return new Response('<html>blocked</html>', { status });
    const { username } = JSON.parse(init.body);
    return new Response(JSON.stringify({ taken: !available.has(username) }), { status: 200 });
  };
  fn.calls = () => calls;
  return fn;
}
