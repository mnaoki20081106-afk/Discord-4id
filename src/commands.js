import { totalFor } from './generator.js';
import { countByStatus, getState, listFound, seqOf } from './store.js';

const STATUS_LABEL = { available: '✅ 使える', taken: '❌ 使えない' };

export function getOptions(interaction) {
  const opts = {};
  for (const o of interaction.data?.options || []) opts[o.name] = o.value;
  const status = opts.status === 'taken' ? 'taken' : opts.status === 'all' ? null : 'available';
  return {
    status,
    count: Math.min(Math.max(Number(opts.count) || 20, 1), 50),
    hidden: Boolean(opts.hidden),
  };
}

const rel = (ts) => (ts ? `<t:${Math.floor(Number(ts) / 1000)}:R>` : 'まだ');

export async function buildStats(db, cfg, now = Date.now()) {
  const [state, counts] = await Promise.all([getState(db), countByStatus(db)]);
  const lines = cfg.lengths.map((len) => {
    const total = totalFor(len, cfg.charset);
    const seq = seqOf(state, len);
    const pass = Math.floor(seq / total) + 1;
    const pct = (((seq % total) / total) * 100).toFixed(3);
    return `${len}文字スキャン: ${pass}周目 ${pct}% (${(seq % total).toLocaleString()}/${total.toLocaleString()})`;
  });
  lines.push(`リスト: ✅ 使える ${counts.available}件 ・ ❌ 使えない ${counts.taken}件`);
  lines.push(`最終チェック: ${rel(state.last_ok_at)} ・ 累計 ${Number(state.checked_total || 0).toLocaleString()}件`);
  if (state.last_error) lines.push(`⚠ 最後のエラー: ${state.last_error.slice(0, 150)}`);
  return lines.join('\n');
}

export function formatList(rows, status) {
  const title =
    status === 'available' ? '✅ 使える ID' : status === 'taken' ? '❌ 使えなくなった ID' : '📋 見つけた ID（すべて）';
  if (!rows.length) {
    return `**${title}**\n${status === 'taken' ? 'まだありません。' : 'まだ見つかっていません。スキャンが進むまでお待ちください。'}`;
  }
  const lines = rows.map((r) => {
    const mark = status ? '' : `${STATUS_LABEL[r.status]} `;
    const when = r.status === 'available' ? `確認 ${rel(r.checked_at)}` : `取られた ${rel(r.changed_at)}`;
    return `${mark}\`${r.name}\` ・ ${when}`;
  });
  return `**${title}** — ${rows.length}件\n${lines.join('\n')}`;
}

export async function buildIdMessage(db, cfg, opts, { now = Date.now } = {}) {
  const rows = await listFound(db, { status: opts.status, limit: opts.count });
  let content = `${formatList(rows, opts.status)}\n\n${await buildStats(db, cfg, now())}`;
  if (content.length > 2000) content = content.slice(0, 1990) + '\n…';
  return { content, allowed_mentions: { parse: [] } };
}

/** Discord に登録するコマンド定義 */
export const COMMANDS = [
  {
    name: 'id',
    description: '見つけた 4文字 Discord ID のリスト（使える / 使えない）を表示',
    integration_types: [0, 1],
    contexts: [0, 1, 2],
    options: [
      {
        type: 3,
        name: 'status',
        description: '表示するリスト（既定: 使える）',
        required: false,
        choices: [
          { name: '✅ 使える', value: 'available' },
          { name: '❌ 使えない（取られた）', value: 'taken' },
          { name: '📋 すべて', value: 'all' },
        ],
      },
      { type: 4, name: 'count', description: '表示件数 (1〜50, 既定20)', required: false, min_value: 1, max_value: 50 },
      { type: 5, name: 'hidden', description: '自分だけに表示する', required: false },
    ],
  },
  {
    name: 'channel',
    description: '空きIDが見つかった時の通知先に、このチャンネルを設定（全部アルファベット/3文字IDは@everyone付き）',
    integration_types: [0],
    contexts: [0],
    default_member_permissions: '32', // MANAGE_GUILD。鯖管理者だけに絞る
  },
];
