// ── Logging utility ───────────────────────────────────────────────────────────
// Loaded via importScripts('./logger.js') in the service worker.
// `logger` becomes a global after that call — no import/export needed.
//
// Levels (most → least verbose): debug > info > warn > error
// Change LOG_LEVEL below to reduce noise.
//
// Usage:
//   logger.warn('[background]', 'something went wrong');
//   logger.info('[workflow]', `processing ${n} leads`);

const LOG_LEVEL = 'debug'; // 'error' | 'warn' | 'info' | 'debug'

const _levels = { error: 0, warn: 1, info: 2, debug: 3 };
const _current = _levels[LOG_LEVEL] ?? _levels.debug;

function _log(level, prefix, message) {
  if ((_levels[level] ?? 3) > _current) return;
  const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${time}] ${prefix} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const logger = {
  error: (prefix, msg) => _log('error', prefix, msg),
  warn:  (prefix, msg) => _log('warn',  prefix, msg),
  info:  (prefix, msg) => _log('info',  prefix, msg),
  debug: (prefix, msg) => _log('debug', prefix, msg),
};
