import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CHARSET } from '../src/config.js';
import { indexToName, isValidUsername, seqToName, totalFor } from '../src/generator.js';

test('indexToName', () => {
  assert.equal(indexToName(0, 3, 'abc'), 'aaa');
  assert.equal(indexToName(5, 3, 'abc'), 'abc');
  assert.equal(indexToName(26, 3, 'abc'), 'ccc');
});

test('isValidUsername', () => {
  assert.ok(isValidUsername('a.b_'));
  assert.ok(!isValidUsername('a..b'));
  assert.ok(!isValidUsername('ABC'));
  assert.ok(!isValidUsername('a'));
});

test('1周で全組み合わせを重複なく通る（3文字・フル文字セット）', () => {
  const n = totalFor(3, DEFAULT_CHARSET);
  for (const pass of [0, 1]) {
    const seen = new Set();
    for (let i = 0; i < n; i++) seen.add(seqToName(pass * n + i, 3, DEFAULT_CHARSET));
    assert.equal(seen.size, n);
  }
  // 周回ごとに順番が変わる
  assert.notEqual(seqToName(0, 3, DEFAULT_CHARSET), seqToName(n, 3, DEFAULT_CHARSET));
});

test('4文字でも安全な整数範囲', () => {
  const n = totalFor(4, DEFAULT_CHARSET);
  assert.ok(n * n < Number.MAX_SAFE_INTEGER);
  assert.equal(seqToName(n - 1, 4, DEFAULT_CHARSET).length, 4);
});

test('paceMs: レート制限ヘッダーに合わせて待つ', async () => {
  const { paceMs } = await import('../src/checker.js');
  assert.equal(paceMs(null, 1000), 1000);
  assert.equal(paceMs({ remaining: 0, resetAfter: 10 }, 1000), 10250);
  assert.equal(paceMs({ remaining: 4, resetAfter: 10 }, 1000), 2000);
  assert.equal(paceMs({ remaining: 49, resetAfter: 1 }, 1000), 1000);
});
