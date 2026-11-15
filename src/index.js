import { buildIdMessage, buildStats, getOptions } from './commands.js';
import { loadConfig } from './config.js';
import { EPHEMERAL, InteractionType, ResponseType, editOriginal, json, verifyDiscordRequest } from './discord.js';
import { isValidUsername } from './generator.js';
import { buildQueue, runScan } from './scanner.js';
import { applyResults } from './store.js';

function authorized(request, env) {
  const auth = request.headers.get('authorization') || '';
  return Boolean(env.SCAN_SECRET) && auth === `Bearer ${env.SCAN_SECRET}`;
}

async function handleInteraction(request, env, ctx) {
  const { ok, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!ok) return new Response('invalid request signature', { status: 401 });
  const interaction = JSON.parse(body);

  if (interaction.type === InteractionType.PING) return json({ type: ResponseType.PONG });

  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data?.name === 'id') {
    const cfg = loadConfig(env);
    const opts = getOptions(interaction);
    const flags = opts.hidden ? EPHEMERAL : 0;

    if (opts.verify) {
      // 再確認は 3 秒を超えるので deferred で返して後から編集
      const appId = env.DISCORD_APPLICATION_ID || interaction.application_id;
      ctx.waitUntil(
        buildIdMessage(env.DB, cfg, opts)
          .catch((e) => ({ content: `エラー: ${e.message}` }))
          .then((msg) => editOriginal(appId, interaction.token, msg)),
      );
      return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags } });
    }
    const msg = await buildIdMessage(env.DB, cfg, opts);
    return json({ type: ResponseType.CHANNEL_MESSAGE, data: { ...msg, flags } });
  }

  return json({ type: ResponseType.CHANNEL_MESSAGE, data: { content: '不明なコマンドです', flags: EPHEMERAL } });
}

/** 外部スキャナー (GitHub Actions 等) 用: 次に調べる名前を返す */
async function handleBatch(request, env, url) {
  if (!authorized(request, env)) return new Response('unauthorized', { status: 401 });
  const cfg = loadConfig(env);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
  const { queue } = await buildQueue(env.DB, cfg, limit, Date.now());
  return json({ items: queue, delayMs: cfg.delayMs });
}

/** 外部スキャナー用: 結果を受け取る */
async function handleReport(request, env) {
  if (!authorized(request, env)) return new Response('unauthorized', { status: 401 });
  const cfg = loadConfig(env);
  const payload = await request.json().catch(() => null);
  if (!payload || !Array.isArray(payload.results)) return new Response('bad request', { status: 400 });
  const results = payload.results
    .filter(
      (r) =>
        typeof r?.name === 'string' &&
        isValidUsername(r.name) &&
        cfg.lengths.includes(r.name.length) &&
        [...r.name].every((c) => cfg.charset.includes(c)) &&
        typeof r.taken === 'boolean',
    )
    .slice(0, 1000)
    .map((r) => ({ name: r.name, len: r.name.length, taken: r.taken, seq: Number.isInteger(r.seq) ? r.seq : undefined }));
  const now = Date.now();
  const extra = {};
  if (results.length) extra.last_ok_at = now;
  if (typeof payload.error === 'string' && payload.error) extra.last_error = `${new Date(now).toISOString()} [external] ${payload.error}`.slice(0, 300);
  await applyResults(env.DB, results, now, extra);
  return json({ ok: true, accepted: results.length });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/interactions')) {
        return await handleInteraction(request, env, ctx);
      }
      if (request.method === 'GET' && url.pathname === '/api/batch') return await handleBatch(request, env, url);
      if (request.method === 'POST' && url.pathname === '/api/report') return await handleReport(request, env);
      if (request.method === 'GET' && url.pathname === '/') {
        const stats = await buildStats(env.DB, loadConfig(env)).catch((e) => `DB error: ${e.message}`);
        return new Response(`discord-4id is running\n\n${stats}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      return new Response('not found', { status: 404 });
    } catch (e) {
      console.error(e);
      return new Response('internal error', { status: 500 });
    }
  },

  async scheduled(_event, env, ctx) {
    const cfg = loadConfig(env);
    if (cfg.mode !== 'worker') return;
    ctx.waitUntil(runScan(env.DB, cfg).then((r) => console.log(JSON.stringify(r))));
  },
};
