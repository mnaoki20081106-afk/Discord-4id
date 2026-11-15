// 無料プロキシ経由で Discord の非認証確認API (username-attempt-unauthed) を叩くためのプール管理。
// 各ソースから ip:port を集めて、実際に Discord まで抜けるものだけ残す（HTTP/HTTPSのみ。SOCKSはundiciが
// ネイティブ対応しないので除外）。各プロキシは別IPなので、1本ずつ独立したレート制限バケットを持つ想定。
import { fetch as undiciFetch, ProxyAgent } from 'undici';
// Node のグローバル fetch は内蔵版 undici を使っており、npm の undici パッケージが作る
// ProxyAgent（dispatcher）を渡すとインターセプタのバージョン不一致で
// "UND_ERR_INVALID_ARG: invalid onRequestStart method" になる。
// dispatcher を使うときは同じ undici パッケージの fetch を使う。

export const DEFAULT_PROXY_SOURCES = [
  { name: 'xyzs996', url: 'https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/proxies/all/data.txt' },
  { name: 'monosans', url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt' },
  { name: 'proxifly', url: 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt' },
  {
    name: 'proxyscrape',
    url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all&limit=2000',
  },
  { name: 'maximilianfeix', url: 'https://raw.githubusercontent.com/maximilianfeix/free-proxy-list/main/all.txt' },
  { name: 'databay-labs', url: 'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/http.txt' },
  { name: 'TheSpeedX', url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt' },
  { name: 'clarketm', url: 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt' },
  { name: 'ShiftyTR', url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt' },
  { name: 'jetkai', url: 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt' },
  { name: 'mmpx12', url: 'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt' },
  { name: 'zloi-user', url: 'https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt' },
  { name: 'roosterkid', url: 'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt' },
  { name: 'sunny9577', url: 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt' },
  { name: 'hendrikbgr', url: 'https://raw.githubusercontent.com/hendrikbgr/Free-Proxy-Repo/master/proxy_list.txt' },
  { name: 'vakhov', url: 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt' },
  { name: 'MuRongPIG', url: 'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt' },
  { name: 'Anonym0usWork1221', url: 'https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/http_proxies.txt' },
  { name: 'r00tee', url: 'https://raw.githubusercontent.com/r00tee/Proxy-List/main/Https.txt' },
  { name: 'proxy4parsing', url: 'https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt' },
  { name: 'saisuiu', url: 'https://raw.githubusercontent.com/saisuiu/Lionkings-Http-Proxys-Proxies/main/free.txt' },
  { name: 'B4RC0DE-TM', url: 'https://raw.githubusercontent.com/B4RC0DE-TM/proxy-list/main/HTTP.txt' },
];

const LINE_RE = /^(?:(https?|socks[45]):\/\/)?(?:[^@\s/]+@)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/i;

export function parseProxyLine(line) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  const m = s.match(LINE_RE);
  if (!m) return null;
  const protocol = (m[1] || 'http').toLowerCase();
  if (protocol.startsWith('socks')) return null; // undici の ProxyAgent は HTTP(S) プロキシのみ
  const port = Number(m[3]);
  if (!(port > 0 && port < 65536)) return null;
  return { protocol, host: m[2], port };
}

export function proxyKey(p) {
  return `${p.protocol}://${p.host}:${p.port}`;
}

/** 各ソースを並列取得してユニークなプロキシ一覧にする（1ソース失敗しても他は続行） */
export async function fetchProxyCandidates(sources = DEFAULT_PROXY_SOURCES, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const out = new Map();
  await Promise.all(
    sources.map(async (src) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let res;
        try {
          res = await fetchImpl(src.url, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          console.error(`[proxy-pool] ${src.name}: HTTP ${res.status}`);
          return;
        }
        const text = await res.text();
        let n = 0;
        for (const line of text.split(/\r?\n/)) {
          const p = parseProxyLine(line);
          if (!p) continue;
          out.set(proxyKey(p), p);
          n++;
        }
        console.log(`[proxy-pool] ${src.name}: ${n}件`);
      } catch (e) {
        console.error(`[proxy-pool] ${src.name}: 取得失敗 ${e.message}`);
      }
    }),
  );
  return [...out.values()];
}

/** 指定プロキシ経由で fetch するラッパーを作る（checker.checkUsername の fetchImpl にそのまま渡せる） */
export function makeProxyFetch(proxy, { requestTimeoutMs = 8000 } = {}) {
  const agent = new ProxyAgent({ uri: proxyKey(proxy), proxyTls: { rejectUnauthorized: false }, requestTls: { rejectUnauthorized: false } });
  return async (url, opts = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
    try {
      return await undiciFetch(url, { ...opts, dispatcher: agent, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 配列を limit 並列で処理する簡易ワーカープール */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return results;
}
