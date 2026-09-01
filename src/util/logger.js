const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { dim: '', red: '', yellow: '', green: '', cyan: '', bold: '', reset: '' };

function emit(level, color, args) {
  if (LEVELS[level] < threshold) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${color}${args.map(fmt).join(' ')}${C.reset}\n`);
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? v.message;
  return JSON.stringify(v);
}

export const log = {
  debug: (...a) => emit('debug', C.dim, a),
  info: (...a) => emit('info', '', a),
  ok: (...a) => emit('info', C.green, ['✓', ...a]),
  warn: (...a) => emit('warn', C.yellow, ['!', ...a]),
  error: (...a) => emit('error', C.red, ['✗', ...a]),
  step: (...a) => emit('info', C.cyan, ['→', ...a]),
  plain: (...a) => process.stdout.write(a.map(fmt).join(' ') + '\n'),
};

export const colors = C;

/** Render an array of objects as an aligned table. */
export function table(rows, columns) {
  if (!rows.length) return log.plain(`${C.dim}(no rows)${C.reset}`);
  const cols = columns ?? Object.keys(rows[0]).map((k) => ({ key: k, label: k }));
  const widths = cols.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? '').length)),
  );
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  log.plain(C.bold + line(cols.map((c) => c.label)) + C.reset);
  log.plain(C.dim + widths.map((w) => '─'.repeat(w)).join('  ') + C.reset);
  for (const r of rows) log.plain(line(cols.map((c) => r[c.key])));
}
