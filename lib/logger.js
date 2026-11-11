// Minimal leveled logger (no deps). Writes one line per event to stdout/stderr.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function fmtArg(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

export function createLogger(level = 'info', prefix = '') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lv, args) => {
    if ((LEVELS[lv] ?? LEVELS.info) < threshold) return;
    const line = `[${new Date().toISOString()}] ${lv.toUpperCase().padEnd(5)} ${prefix}${args.map(fmtArg).join(' ')}`;
    if (lv === 'error') console.error(line); else console.log(line);
  };
  return {
    level,
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    child: (childPrefix) => createLogger(level, prefix + childPrefix),
  };
}
