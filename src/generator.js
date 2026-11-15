// 総当り用の名前生成。
// 先頭から順番 (aaa, aab, ...) だと偏るので、周回ごとに「n と互いに素な step」で
// 0..n-1 を並べ替えた順で回す（全組み合わせを重複なく1回ずつ通る）。

export function totalFor(len, charset) {
  return charset.length ** len;
}

export function indexToName(index, len, charset) {
  const base = charset.length;
  let out = '';
  for (let i = 0; i < len; i++) {
    out = charset[index % base] + out;
    index = Math.floor(index / base);
  }
  return out;
}

/** Discord のユーザー名ルール: 英小文字/数字/_/. のみ、2〜32文字、ピリオド連続 NG */
export function isValidUsername(name) {
  return /^[a-z0-9_.]{2,32}$/.test(name) && !name.includes('..');
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** 周回 pass ごとの並べ替えパラメータ */
export function permutationFor(n, pass, len) {
  const h = hash32(pass * 7919 + len * 104729 + 1);
  let step = Math.floor(n * 0.6180339887) + (h % 997);
  if (step < 1) step = 1;
  while (gcd(step, n) !== 1) step++;
  return { step: step % n || 1, offset: hash32(h) % n };
}

/** 通し番号 seq（周回をまたいで単調増加）→ 名前 */
export function seqToName(seq, len, charset) {
  const n = totalFor(len, charset);
  const pass = Math.floor(seq / n);
  const pos = seq % n;
  const { step, offset } = permutationFor(n, pass, len);
  // pos*step は n<2^26 程度なら 2^53 に収まる（38^4 ≒ 2.1M）
  const idx = (pos * step + offset) % n;
  return indexToName(idx, len, charset);
}
