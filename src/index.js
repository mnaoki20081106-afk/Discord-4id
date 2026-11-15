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

/**
 * GitHub Actions の scan ワークフローを workflow_dispatch で起動する。
 * Worker (Cloudflare) 自身の IP からは Discord の確認APIが 403 で弾かれるため、
 * 実際のスキャンは常に GitHub Actions 側の IP で行う前提。ここはそれを起動するだけ。
 * GITHUB_PAT は対象リポジトリ限定・Actions:Read and write だけの fine-grained PAT を想定。
 */
async function triggerScanWorkflow(env) {
  const repo = env.GITHUB_REPO || 'mnaoki20081106-afk/Discord-4id';
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scan.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'discord-4id-worker',
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'main' }),
  });
  return res;
}

/**
 * 新しく見つかった名前を、/channel で設定したチャンネルに即時通知する。
 * urgent（全部アルファベット or 3文字ID）は @everyone 付きで別メッセージとして送る。
 */
function makeNotifier(env) {
  return async (finds) => {
    if (!env.DISCORD_BOT_TOKEN || !finds?.length) return;
    const state = await getState(env.DB);
    const channelId = state.notify_channel_id;
    if (!channelId) return;

    const urgent = finds.filter((f) => f.urgent);
    const normal = finds.filter((f) => !f.urgent);
    const fmt = (list) => list.map((f) => `\`${f.name}\``).join(', ');

    if (urgent.length) {
      await sendChannelMessage(env.DISCORD_BOT_TOKEN, channelId, `@everyone 🚨 空き発見: ${fmt(urgent)}`, { mentionEveryone: true });
    }
    if (normal.length) {
      await sendChannelMessage(env.DISCORD_BOT_TOKEN, channelId, `🆕 空き発見: ${fmt(normal)}`);
    }
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

  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data?.name === 'scan') {
    if (!env.GITHUB_PAT) {
      return json({
        type: ResponseType.CHANNEL_MESSAGE,
        data: { content: '⚠ GITHUB_PAT が未設定なのでスキャンを起動できません（`wrangler secret put GITHUB_PAT` が必要）。', flags: EPHEMERAL },
      });
    }
    const res = await triggerScanWorkflow(env).catch((e) => ({ ok: false, status: 0, _err: String(e?.message || e) }));
    const content =
      res.status === 204
        ? '🚀 スキャンを起動しました（GitHub Actions）。終わるまで数分〜1時間弱かかります。'
        : `⚠ 起動に失敗しました（HTTP ${res.status}${res._err ? ` ${res._err}` : ''}）`;
    return json({ type: ResponseType.CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL } });
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

/** 外部スキャナー用: 実行中の進捗メッセージを /channel で設定したチャンネルにそのまま転送する */
async function handleProgress(request, env) {
  if (!authorized(request, env)) return new Response('unauthorized', { status: 401 });
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload.message !== 'string' || !payload.message) return new Response('bad request', { status: 400 });
  const state = await getState(env.DB);
  const channelId = state.notify_channel_id;
  if (channelId && env.DISCORD_BOT_TOKEN) {
    await sendChannelMessage(env.DISCORD_BOT_TOKEN, channelId, payload.message.slice(0, 1900)).catch((e) =>
      console.error('[progress] failed', e),
    );
  }
  return json({ ok: true });
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
      if (request.method === 'POST' && url.pathname === '/api/progress') return await handleProgress(request, env);
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
