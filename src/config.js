export const DEFAULT_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789_.';

function int(v, def) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

/** env (wrangler vars / process.env) から設定を読む */
export function loadConfig(env = {}) {
  const charset = [...new Set((env.CHARSET || DEFAULT_CHARSET).toLowerCase())].join('');
  const lengths = String(env.SCAN_LENGTHS || '3,4')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => n >= 2 && n <= 32);
  return {
    charset,
    lengths: lengths.length ? lengths : [3, 4],
    batch: Math.min(Math.max(int(env.SCAN_BATCH, 20), 1), 45),
    delayMs: Math.max(int(env.SCAN_DELAY_MS, 700), 0),
    recheckMs: Math.max(int(env.RECHECK_HOURS, 12), 1) * 3600_000,
    mode: env.SCAN_MODE === 'external' ? 'external' : 'worker',
  };
}
