import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIdMessage } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { seqToName } from '../src/generator.js';
import { runScan } from '../src/scanner.js';
import { getState, listAvailable } from '../src/store.js';
import { createFakeD1, mockDiscord } from './fake-d1.js';

const cfg = loadConfig({ SCAN_BATCH: '20', SCAN_DELAY_MS: '0' });
const noSleep = async () => {};

test('スキャンで空きを保存しカーソルが進む', async () => {
  const db = createFakeD1();
  const targets = new Set([seqToName(3, 3, cfg.charset), seqToName(10, 3, cfg.charset)]);
  const fetchImpl = mockDiscord({ available: targets });
  const r = await runScan(db, cfg, { fetchImpl, sleep: noSleep });
  assert.equal(r.checked, 20);
  const st = await getState(db);
  assert.ok(Number(st['seq:3']) >= 20);
  assert.equal(st['seq:4'], undefined); // 3文字を先に回す
  const rows = await listAvailable(db, { len: 3 });
  assert.deepEqual(new Set(rows.map((x) => x.name)), targets);
});

test('429 でクールダウンし、次回はスキップ', async () => {
  const db = createFakeD1();
  const fetchImpl = mockDiscord({ rateLimitAfter: 5 });
  const r = await runScan(db, cfg, { fetchImpl, sleep: noSleep });
  assert.equal(r.checked, 5);
  assert.ok(r.cooldown_until > Date.now());
  const st = await getState(db);
  assert.ok(Number(st['seq:3']) <= 6);
  const r2 = await runScan(db, cfg, { fetchImpl, sleep: noSleep });
  assert.equal(r2.skipped, 'cooldown');
});

test('ブロック(403)はエラー記録', async () => {
  const db = createFakeD1();
  const r = await runScan(db, cfg, { fetchImpl: mockDiscord({ status: 403 }), sleep: noSleep });
  assert.equal(r.checked, 0);
  assert.match((await getState(db)).last_error, /HTTP 403/);
});

test('3文字を1周したら4文字へ', async () => {
  const db = createFakeD1();
  const n3 = cfg.charset.length ** 3;
  await db.prepare("INSERT INTO state (key, value) VALUES ('seq:3', ?)").bind(String(n3)).run();
  const r = await runScan(db, cfg, { fetchImpl: mockDiscord({ available: new Set() }), sleep: noSleep });
  assert.equal(r.checked, 20);
  assert.ok(Number((await getState(db))['seq:4']) >= 20);
});

test('/id: 一覧と verify で取られた名前を除外', async () => {
  const db = createFakeD1();
  const now = Date.now();
  for (const n of ['ab1', 'xy_', 'q.zz']) {
    await db.prepare('INSERT INTO available (name, len, found_at, checked_at) VALUES (?, ?, ?, ?)').bind(n, n.length, now, now).run();
  }
  const plain = await buildIdMessage(db, cfg, { len: 3, count: 20, verify: false });
  assert.match(plain.content, /ab1/);
  assert.match(plain.content, /xy_/);
  assert.doesNotMatch(plain.content, /q\.zz/);

  const fetchImpl = mockDiscord({ available: new Set(['ab1']) });
  const v = await buildIdMessage(db, cfg, { len: null, count: 20, verify: true }, { fetchImpl });
  assert.match(v.content, /ab1/);
  assert.doesNotMatch(v.content, /xy_/);
  assert.match(v.content, /2件は取られていた/);
  assert.equal((await listAvailable(db, {})).length, 1);
});
