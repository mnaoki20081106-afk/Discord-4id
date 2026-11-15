import { checkUsername } from './checker.js';
import { totalFor } from './generator.js';
import { applyResults, countByLen, getState, listAvailable, seqOf } from './store.js';

export const MAX_VERIFY = 10;

export function getOptions(interaction) {
  const opts = {};
  for (const o of interaction.data?.options || []) opts[o.name] = o.value;
  const len = opts.length && opts.length !== 'any' ? Number(opts.length) : null;
  return {
    len,
    count: Math.min(Math.max(Number(opts.count) || 20, 1), 100),
    verify: Boolean(opts.verify),
    random: Boolean(opts.random),
    hidden: Boolean(opts.hidden),
  };
}

function rel(ts, now) {
  if (!ts) return 'まだ';
  return `<t:${Math.floor(Number(ts) / 1000)}:R>`;
}

export async function buildStats(db, cfg, now = Date.now()) {
  const [state, counts] = await Promise.all([getState(db), countByLen(db)]);
  const lines = cfg.lengths.map((len) => {
    const total = totalFor(len, cfg.charset);
    const seq = seqOf(state, len);
    const pass = Math.floor(seq / total) + 1;
    const pct = (((seq % total) / total) * 100).toFixed(2);
    return `${len}文字: ${pass}周目 ${pct}% (${(seq % total).toLocaleString()}/${total.toLocaleString()}) ・空き ${counts[len] || 0}件`;
  });
  lines.push(`最終スキャン: ${rel(state.last_ok_at, now)} ・累計チェック: ${Number(state.checked_total || 0).toLocaleString()}件`);
  if (Number(state.cooldown_until || 0) > now) lines.push(`⏸ ${state.cooldown_reason === 'error' ? 'エラーのため' : 'レート制限で'}休止中（${rel(state.cooldown_until, now)} 再開）`);
  if (state.last_error) lines.push(`⚠ 最後のエラー: ${state.last_error.slice(0, 150)}`);
  return lines.join('\n');
}

export function formatList(rows, { len, verified }) {
  const title = `🔎 使えそうな${len ? `${len}文字` : '3〜4文字'}ID${verified ? '（いま再確認済み ✅）' : ''}`;
  if (!rows.length) return `${title}\nまだ見つかっていません。スキャンが進むまでお待ちください。`;
  const names = rows.map((r) => r.name).join('\n');
  return `${title} — ${rows.length}件\n\`\`\`\n${names}\n\`\`\``;
}

/** /id の中身を作る（verify=true ならライブで再確認して古い情報を消す） */
export async function buildIdMessage(db, cfg, opts, { fetchImpl = fetch, now = Date.now } = {}) {
  let rows = await listAvailable(db, { len: opts.len, limit: opts.count, random: opts.random });
  let note = '';
  if (opts.verify && rows.length) {
    const target = rows.slice(0, MAX_VERIFY);
    const results = [];
    for (const row of target) {
      const r = await checkUsername(row.name, { fetchImpl });
      if (r.status === 'available' || r.status === 'taken') results.push({ name: row.name, len: row.len, taken: r.status === 'taken' });
      else {
        note = r.status === 'ratelimited' ? '\n（レート制限のため一部のみ再確認）' : `\n（再確認エラー HTTP ${r.code}）`;
        break;
      }
    }
    if (results.length) await applyResults(db, results, now());
    const takenNow = new Set(results.filter((r) => r.taken).map((r) => r.name));
    rows = target.filter((r) => !takenNow.has(r.name) && results.some((x) => x.name === r.name));
    if (takenNow.size) note += `\n（${takenNow.size}件は取られていたので除外）`;
  }
  let content = formatList(rows, { len: opts.len, verified: opts.verify }) + note;
  content += `\n\n${await buildStats(db, cfg, now())}`;
  if (content.length > 2000) content = content.slice(0, 1990) + '\n…';
  return { content, allowed_mentions: { parse: [] } };
}

/** Discord に登録するコマンド定義 */
export const COMMANDS = [
  {
    name: 'id',
    description: '使える(空いている) Discord の 3〜4文字ユーザー名の一覧を表示',
    integration_types: [0, 1],
    contexts: [0, 1, 2],
    options: [
      {
        type: 3,
        name: 'length',
        description: '文字数',
        required: false,
        choices: [
          { name: '3文字', value: '3' },
          { name: '4文字', value: '4' },
          { name: 'すべて', value: 'any' },
        ],
      },
      { type: 4, name: 'count', description: '表示件数 (1〜100, 既定20)', required: false, min_value: 1, max_value: 100 },
      { type: 5, name: 'verify', description: `送信前にいま空いているか再確認する（最大${MAX_VERIFY}件）`, required: false },
      { type: 5, name: 'random', description: 'ランダムに選ぶ', required: false },
      { type: 5, name: 'hidden', description: '自分だけに表示する', required: false },
    ],
  },
];
