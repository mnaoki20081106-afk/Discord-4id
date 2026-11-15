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
  await env.DB.prepare("INSERT INTO found VALUES (?, 4, 'available', 0, 0, 0)").bind('zz9_').run();
  const body = JSON.stringify({ type: 2, token: 't', data: { name: 'id', options: [{ name: 'status', value: 'available' }] } });
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
  results.push({ name: '../evil', len: 4, taken: false }, { name: 'abc', len: 3, taken: false });
  const rep = await worker.fetch(
    new Request('https://w.example/api/report', { method: 'POST', headers: auth, body: JSON.stringify({ results }) }),
    env,
    ctx,
  );
  assert.equal((await rep.json()).accepted, 5);
  const b2 = await (await worker.fetch(new Request('https://w.example/api/batch?limit=5', { headers: auth }), env, ctx)).json();
  assert.notEqual(b2.items[0].name, b.items[0].name); // カーソルが進んでいる
});

test('/channel: 通知先チャンネルを設定し、DISCORD_BOT_TOKEN 未設定なら注意書きが出る', async () => {
  const { env, sign } = await setup();
  const body = JSON.stringify({ type: 2, token: 't', guild_id: 'g1', channel_id: 'c1', data: { name: 'channel' } });
  const res = await worker.fetch(await sign(body), env, ctx);
  const j = await res.json();
  assert.equal(j.data.flags, 1 << 6);
  assert.match(j.data.content, /設定しました/);
  assert.match(j.data.content, /DISCORD_BOT_TOKEN/);

  const { getState } = await import('../src/store.js');
  const state = await getState(env.DB);
  assert.equal(state.notify_channel_id, 'c1');
});

test('/channel: サーバー外では使えない', async () => {
  const { env, sign } = await setup();
  const body = JSON.stringify({ type: 2, token: 't', data: { name: 'channel' } }); // guild_id なし
  const res = await worker.fetch(await sign(body), env, ctx);
  const j = await res.json();
  assert.match(j.data.content, /サーバー内/);
});

test('外部スキャナー: 新規空きが見つかったら通知チャンネルに送る（urgentは@everyone付きで別送）', async () => {
  const { env } = await setup();
  const { setState } = await import('../src/store.js');
  await setState(env.DB, { notify_channel_id: 'c1' });
  env.DISCORD_BOT_TOKEN = 'bot-token';

  const sentTo = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/channels/c1/messages')) {
      sentTo.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    return origFetch(url, init);
  };
  try {
    const auth = { authorization: 'Bearer s3cret' };
    const results = [
      { name: 'abcd', len: 4, taken: false }, // 全部アルファベット → urgent
      { name: 'ab12', len: 4, taken: false }, // 数字入り4文字 → 通常
    ];
    const res = await worker.fetch(
      new Request('https://w.example/api/report', { method: 'POST', headers: auth, body: JSON.stringify({ results }) }),
      env,
      ctx,
    );
    assert.equal((await res.json()).accepted, 2);
    assert.equal(sentTo.length, 2);
    const urgentMsg = sentTo.find((m) => m.content.includes('abcd'));
    const normalMsg = sentTo.find((m) => m.content.includes('ab12'));
    assert.match(urgentMsg.content, /@everyone/);
    assert.deepEqual(urgentMsg.allowed_mentions.parse, ['everyone']);
    assert.doesNotMatch(normalMsg.content, /@everyone/);
    assert.deepEqual(normalMsg.allowed_mentions.parse, []);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('/scan: GITHUB_PAT 未設定なら起動しない', async () => {
  const { env, sign } = await setup();
  const body = JSON.stringify({ type: 2, token: 't', guild_id: 'g1', data: { name: 'scan' } });
  const res = await worker.fetch(await sign(body), env, ctx);
  const j = await res.json();
  assert.match(j.data.content, /GITHUB_PAT/);
  assert.equal(j.data.flags, 1 << 6);
});

test('/scan: GitHub Actions の workflow_dispatch を正しい宛先で叩く', async () => {
  const { env, sign } = await setup();
  env.GITHUB_PAT = 'ghp_test';

  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.github.com')) {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }
    return origFetch(url, init);
  };
  try {
    const body = JSON.stringify({ type: 2, token: 't', guild_id: 'g1', data: { name: 'scan' } });
    const res = await worker.fetch(await sign(body), env, ctx);
    const j = await res.json();
    assert.match(j.data.content, /起動しました/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/repos/mnaoki20081106-afk/Discord-4id/actions/workflows/scan.yml/dispatches');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ghp_test');
    assert.deepEqual(JSON.parse(calls[0].init.body), { ref: 'main' });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('/scan: GitHub側が失敗応答ならエラーを返す', async () => {
  const { env, sign } = await setup();
  env.GITHUB_PAT = 'ghp_test';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url).includes('api.github.com') ? new Response('nope', { status: 403 }) : origFetch(url, init);
  try {
    const body = JSON.stringify({ type: 2, token: 't', guild_id: 'g1', data: { name: 'scan' } });
    const res = await worker.fetch(await sign(body), env, ctx);
    const j = await res.json();
    assert.match(j.data.content, /失敗/);
    assert.match(j.data.content, /403/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
