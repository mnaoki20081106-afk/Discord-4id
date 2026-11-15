// Discord の「ユーザー名が使えるか」確認 API（登録画面が使っているもの）。
// ユーザートークン不要。レート制限が厳しいので 429 の retry_after を必ず守る。
export const CHECK_URL = 'https://discord.com/api/v9/unique-username/username-attempt-unauthed';

/**
 * @returns {Promise<{status:'available'|'taken'} | {status:'ratelimited', retryAfterMs:number} | {status:'error', code:number, message:string}>}
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
    return { status: 'error', code: 0, message: String(e?.message || e) };
  }

  let body = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    /* HTML (Cloudflare のブロック画面など) */
  }

  if (res.status === 429) {
    const sec = Number(body?.retry_after ?? res.headers.get('retry-after') ?? 60);
    return { status: 'ratelimited', retryAfterMs: Math.ceil((Number.isFinite(sec) ? sec : 60) * 1000) + 500 };
  }
  if (res.ok && body && typeof body.taken === 'boolean') {
    return { status: body.taken ? 'taken' : 'available' };
  }
  return {
    status: 'error',
    code: res.status,
    message: (body?.message || text || '').slice(0, 200),
  };
}
