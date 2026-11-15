import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { createFakeD1 } from './fake-d1.js';

const toHex = (b) => Buffer.from(b).toString('hex');

async function setup() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = toHex(await crypto.subtle.exportKey('raw', kp.publicKey));
  const env = { DB: createFakeD1(), DISCORD_PUBLIC_KEY: pub, DISCORD_APPLICATION_ID: '1', SCAN_SECRET: 's3cret' };
  const sign = async (body) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = toHex(await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(ts + body)));
    return new Request('https://w.example/', {
      method: 'POST',
      headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts, 'content-type': 'application/json' },
      body,
    });
  };
  return { env, sign };
}
const ctx = { waitUntil() {} };

test('PING に PONG、不正署名は 401', async () => {
  const { env, sign } = await setup();
  const res = await worker.fetch(await sign(JSON.stringify({ type: 1 })), env, ctx);
  assert.deepEqual(await res.json(), { type: 1 });
  const bad = new Request('https://w.example/', {
    method: 'POST',
    headers: { 'x-signature-ed25519': '00'.repeat(64), 'x-signature-timestamp': '1' },
    body: '{"type":1}',
  });
  assert.equal((await worker.fetch(bad, env, ctx)).status, 401);
});

test('/id コマンド', async () => {
  const { env, sign } = await setup();
  await env.DB.prepare('INSERT INTO available VALUES (?, 4, 0, 0)').bind('zz9_').run();
  const body = JSON.stringify({ type: 2, token: 't', data: { name: 'id', options: [{ name: 'length', value: '4' }] } });
  const res = await worker.fetch(await sign(body), env, ctx);
  const j = await res.json();
  assert.equal(j.type, 4);
  assert.match(j.data.content, /zz9_/);
});

test('外部スキャナー API', async () => {
  const { env } = await setup();
  const auth = { authorization: 'Bearer s3cret' };
  assert.equal((await worker.fetch(new Request('https://w.example/api/batch'), env, ctx)).status, 401);
  const b = await (await worker.fetch(new Request('https://w.example/api/batch?limit=5', { headers: auth }), env, ctx)).json();
  assert.equal(b.items.length, 5);
  const results = b.items.map((it, i) => ({ ...it, taken: i !== 2 }));
  results.push({ name: '../evil', len: 3, taken: false });
  const rep = await worker.fetch(
    new Request('https://w.example/api/report', { method: 'POST', headers: auth, body: JSON.stringify({ results }) }),
    env,
    ctx,
  );
  assert.equal((await rep.json()).accepted, 5);
  const b2 = await (await worker.fetch(new Request('https://w.example/api/batch?limit=5', { headers: auth }), env, ctx)).json();
  assert.notEqual(b2.items[0].name, b.items[0].name); // カーソルが進んでいる
});
