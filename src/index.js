import { buildIdMessage, buildStats, getOptions } from './commands.js';
import { loadConfig } from './config.js';
import { EPHEMERAL, InteractionType, ResponseType, json, sendChannelMessage, verifyDiscordRequest } from './discord.js';
import { isValidUsername } from './generator.js';
import { buildQueue, runScan } from './scanner.js';
import { applyResults, getState, setState } from './store.js';

function authorized(request, env) {
  const auth = request.headers.get('authorization') || '';
  return Boolean(env.SCAN_SECRET) && auth === `Bearer ${env.SCAN_SECRET}`;
}

/** 新しく見つかった全部アルファベットの名前を、/channel で設定したチャンネルに即時通知する */
function makeNotifier(env) {
  return async (names) => {
    if (!env.DISCORD_BOT_TOKEN || !names?.length) return;
    const state = await getState(env.DB);
    const channelId = state.notify_channel_id;
    if (!channelId) return;
    const list = names.map((n) => `\`${n}\``).join(', ');
    const content = `🔤 全部アルファベットの4文字ID発見: ${list}`;
    await sendChannelMessage(env.DISCORD_BOT_TOKEN, channelId, content);
  };
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

    const msg = await buildIdMessage(env.DB, cfg, opts);
    return json({ type: ResponseType.CHANNEL_MESSAGE, data: { ...msg, flags } });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data?.name === 'channel') {
    if (!interaction.guild_id || !interaction.channel_id) {
      return json({ type: ResponseType.CHANNEL_MESSAGE, data: { content: 'サーバー内のチャンネルでだけ使えます', flags: EPHEMERAL } });
    }
    await setState(env.DB, { notify_channel_id: interaction.channel_id, notify_guild_id: interaction.guild_id });
    const warn = env.DISCORD_BOT_TOKEN
      ? ''
      : '\n⚠ DISCORD_BOT_TOKEN が未設定なので、実際の通知はまだ送れません（`wrangler secret put DISCORD_BOT_TOKEN` が必要）。';
    return json({
      type: ResponseType.CHANNEL_MESSAGE,
      data: { content: `✅ このチャンネルを、全部アルファベットの4文字ID発見通知の送り先に設定しました${warn}`, flags: EPHEMERAL },
    });
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
  const { newlyAvailable } = await applyResults(env.DB, results, now, extra);
  if (newlyAvailable.length) await makeNotifier(env)(newlyAvailable).catch((e) => console.error('[notify] failed', e));
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
    ctx.waitUntil(runScan(env.DB, cfg, { notify: makeNotifier(env) }).then((r) => console.log(JSON.stringify(r))));
  },
};
