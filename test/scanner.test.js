import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIdMessage } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { seqToName } from '../src/generator.js';
import { runScan } from '../src/scanner.js';
import { applyResults, countByStatus, getState, listFound } from '../src/store.js';
import { createFakeD1, mockDiscord } from './fake-d1.js';

const cfg = loadConfig({ SCAN_BATCH: '20', SCAN_DELAY_MS: '0' });
const noSleep = async () => {};

test('既定は4文字だけをスキャン', async () => {
  const db = createFakeD1();
  const targets = new Set([seqToName(3, 4, cfg.charset), seqToName(10, 4, cfg.charset)]);
  const r = await runScan(db, cfg, { fetchImpl: mockDiscord({ available: targets }), sleep: noSleep });
  assert.equal(r.checked, 20);
  const st = await getState(db);
  assert.ok(Number(st['seq:4']) >= 20);
  assert.equal(st['seq:3'], undefined);
  const rows = await listFound(db, { status: 'available' });
  assert.deepEqual(new Set(rows.map((x) => x.name)), targets);
  assert.ok(rows.every((x) => x.len === 4));
});

test('取られた名前はリストに残って「使えない」に仕分けられ、空き直せば「使える」に戻る', async () => {
  const db = createFakeD1();
  await applyResults(db, [{ name: 'ab12', len: 4, taken: false }], 1000);
  await applyResults(db, [{ name: 'zzzz', len: 4, taken: true }], 1000); // リスト外の取られた名前は保存しない
  assert.deepEqual(await countByStatus(db), { available: 1, taken: 0 });

  await applyResults(db, [{ name: 'ab12', len: 4, taken: true }], 2000);
  let [row] = await listFound(db, { status: null });
  assert.equal(row.status, 'taken');
  assert.equal(row.changed_at, 2000);
  await applyResults(db, [{ name: 'ab12', len: 4, taken: true }], 3000);
  [row] = await listFound(db, { status: null });
  assert.equal(row.changed_at, 2000); // 状態が変わらなければ changed_at はそのまま
  assert.equal(row.checked_at, 3000);

  await applyResults(db, [{ name: 'ab12', len: 4, taken: false }], 4000);
  [row] = await listFound(db, { status: 'available' });
  assert.equal(row.name, 'ab12');
  assert.equal(row.found_at, 1000);
  assert.equal(row.changed_at, 4000);
});

test('定期仕分け: 古い「使える」を先に再確認する', async () => {
  const db = createFakeD1();
  const old = Date.now() - 7 * 3600_000;
  await applyResults(db, [{ name: 'q.zz', len: 4, taken: false }], old);
  const fetchImpl = mockDiscord({ available: new Set() }); // もう取られている
  const r = await runScan(db, cfg, { fetchImpl, sleep: noSleep });
  assert.equal(r.checked, 20);
  const [row] = await listFound(db, { status: null });
  assert.equal(row.name, 'q.zz');
  assert.equal(row.status, 'taken');
});

test('429 でクールダウンし、次回はスキップ', async () => {
  const db = createFakeD1();
  const fetchImpl = mockDiscord({ rateLimitAfter: 5 });
  const r = await runScan(db, cfg, { fetchImpl, sleep: noSleep });
  assert.equal(r.checked, 5);
  assert.ok(r.cooldown_until > Date.now());
  assert.equal((await runScan(db, cfg, { fetchImpl, sleep: noSleep })).skipped, 'cooldown');
});

test('ブロック(403)はエラー記録', async () => {
  const db = createFakeD1();
  const r = await runScan(db, cfg, { fetchImpl: mockDiscord({ status: 403 }), sleep: noSleep });
  assert.equal(r.checked, 0);
  assert.match((await getState(db)).last_error, /HTTP 403/);
});

test('3,4 を指定すると 3文字を1周してから4文字へ', async () => {
  const cfg34 = loadConfig({ SCAN_LENGTHS: '3,4', SCAN_DELAY_MS: '0' });
  const db = createFakeD1();
  await db.prepare("INSERT INTO state (key, value) VALUES ('seq:3', ?)").bind(String(cfg34.charset.length ** 3)).run();
  await runScan(db, cfg34, { fetchImpl: mockDiscord(), sleep: noSleep });
  assert.ok(Number((await getState(db))['seq:4']) >= 20);
});

test('/id: 使える / 使えない / すべて', async () => {
  const db = createFakeD1();
  await applyResults(db, [{ name: 'ab_1', len: 4, taken: false }, { name: 'xy.z', len: 4, taken: false }], 1000);
  await applyResults(db, [{ name: 'xy.z', len: 4, taken: true }], 2000);

  const ok = await buildIdMessage(db, cfg, { status: 'available', count: 20 });
  assert.match(ok.content, /✅ 使える ID\*\* — 1件/);
  assert.match(ok.content, /`ab_1`/);
  assert.doesNotMatch(ok.content, /`xy\.z`/);

  const ng = await buildIdMessage(db, cfg, { status: 'taken', count: 20 });
  assert.match(ng.content, /`xy\.z` ・ 取られた/);
  assert.doesNotMatch(ng.content, /`ab_1`/);

  const all = await buildIdMessage(db, cfg, { status: null, count: 20 });
  assert.match(all.content, /✅ 使える `ab_1`[\s\S]*❌ 使えない `xy\.z`/);
  assert.match(all.content, /✅ 使える 1件 ・ ❌ 使えない 1件/);
});
