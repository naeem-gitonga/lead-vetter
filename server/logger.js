// ── Logging utility with level-based filtering ───────────────────────────────
//
//   LOG_LEVEL environment variable controls verbosity:
//     error  — only errors
//     warn   — errors + warnings
//     info   — warn + important info (startup, workflow steps)
//     debug  — all logs (default)
//
//   Usage:
//     const logger = require('./logger');
//     logger.info('module', 'message');

const _levels = { error: 0, warn: 1, info: 2, debug: 3 };
const _current = _levels[(process.env.LOG_LEVEL || 'debug').toLowerCase()] ?? _levels.debug;

function shouldLog(level) {
  return (_levels[level] ?? 0) <= _current;
}

function format(prefix, message) {
  const time = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  return `[${time}] ${prefix} ${message}`;
}

function log(level, prefix, message) {
  if (!shouldLog(level)) return;
  const line = format(prefix, message);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const logger = {
  error: (prefix, message) => log('error', prefix, message || ''),
  warn: (prefix, message) => log('warn', prefix, message || ''),
  info: (prefix, message) => log('info', prefix, message || ''),
  debug: (prefix, message) => log('debug', prefix, message || ''),
};

module.exports = logger;
