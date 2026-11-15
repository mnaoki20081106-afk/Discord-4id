// Discord Interactions の署名検証とレスポンス用ヘルパー

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
export const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4, DEFERRED_CHANNEL_MESSAGE: 5 };
export const EPHEMERAL = 1 << 6;

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Ed25519 署名検証（Workers / Node 22 の WebCrypto） */
export async function verifyDiscordRequest(request, publicKeyHex) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  if (!signature || !timestamp || !publicKeyHex || !/^[0-9a-f]+$/i.test(signature)) return { ok: false, body };
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
    return { ok, body };
  } catch {
    return { ok: false, body };
  }
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

/** deferred 応答の後でメッセージを書き換える */
export async function editOriginal(applicationId, token, data, fetchImpl = fetch) {
  return fetchImpl(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
}
