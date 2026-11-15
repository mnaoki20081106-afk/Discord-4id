// 有料のローテーティング住宅プロキシ（DataImpulse等、ユーザー名にセッションIDを埋め込む方式）用。
// 無料プロキシ版(proxy-pool.js)と違って「死んでるプロキシを探す」工程が無い。
// ゲートウェイに投げれば常に生きてる住宅IPが割り当てられる。セッションIDを変えるとIPが変わる。
import { fetch as undiciFetch, ProxyAgent } from 'undici';

export function randomSessionId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * ゲートウェイ経由で fetch するラッパーを作る（checker.checkUsername の fetchImpl にそのまま渡せる）。
 * 同じ sessionId を使い続ける限り同じ住宅IPに固定される（スティッキーセッション）。
 * 返す関数に `.close()` と `.sessionId` が生えている。
 */
export function makeGatewayFetch({ host, port, login, password, sessionId, requestTimeoutMs = 8000 }) {
  const user = `${login}__sid.${sessionId}`;
  const uri = `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}`;
  const agent = new ProxyAgent({ uri });
  const fn = async (url, opts = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
    try {
      return await undiciFetch(url, { ...opts, dispatcher: agent, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  fn.sessionId = sessionId;
  fn.close = () => agent.close().catch(() => agent.destroy().catch(() => {}));
  return fn;
}
