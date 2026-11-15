// Discord の「ユーザー名が使えるか」確認 API（登録画面が使っているもの）。
// ユーザートークン不要。レスポンスのレート制限ヘッダーを読んで、上限を超えないペースで送る。
export const CHECK_URL = 'https://discord.com/api/v9/unique-username/username-attempt-unauthed';

/** x-ratelimit-* ヘッダーを読む */
export function readRateLimit(headers) {
  const num = (k) => {
    const v = headers.get(k);
    return v === null || v === '' ? null : Number(v);
  };
  return {
    limit: num('x-ratelimit-limit'),
    remaining: num('x-ratelimit-remaining'),
    resetAfter: num('x-ratelimit-reset-after'), // 秒
    bucket: headers.get('x-ratelimit-bucket'),
    scope: headers.get('x-ratelimit-scope'),
    global: headers.get('x-ratelimit-global') === 'true',
  };
}

/**
 * @returns {Promise<{status:'available'|'taken', rate} | {status:'ratelimited', retryAfterMs, rate, body} | {status:'error', code, message, rate}>}
 */
export async function checkUsername(name, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(CHECK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; discord-4id-checker/1.0)',
      },
      body: JSON.stringify({ username: name }),
    });
  } catch (e) {
    // fetch の TypeError はメッセージが "fetch failed" で潰れるので、本当の原因(cause)を拾う
    const detail = e?.cause?.message || e?.cause?.code || '';
    const message = detail ? `${e?.message || e}: ${detail}` : String(e?.message || e);
    return { status: 'error', code: 0, message, rate: null };
  }

  const rate = readRateLimit(res.headers);
  let body = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    /* HTML (Cloudflare のブロック画面など) */
  }

  if (res.status === 429) {
    const sec = Number(body?.retry_after ?? res.headers.get('retry-after') ?? 60);
    return {
      status: 'ratelimited',
      retryAfterMs: Math.ceil((Number.isFinite(sec) ? sec : 60) * 1000) + 500,
      rate,
      body: text.slice(0, 300),
    };
  }
  if (res.ok && body && typeof body.taken === 'boolean') {
    return { status: body.taken ? 'taken' : 'available', rate };
  }
  return { status: 'error', code: res.status, message: (body?.message || text || '').slice(0, 200), rate };
}

/**
 * 次のリクエストまで待つ時間(ms)。
 * 残り回数が 0 ならバケットが回復するまで待つ。残りがあればリセットまでの時間を残り回数で割って均等に送る。
 */
export function paceMs(rate, minDelayMs) {
  if (!rate || rate.remaining === null || rate.resetAfter === null) return minDelayMs;
  const resetMs = rate.resetAfter * 1000;
  if (rate.remaining <= 0) return Math.max(resetMs + 250, minDelayMs);
  return Math.max(Math.ceil(resetMs / (rate.remaining + 1)), minDelayMs);
}
