import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const min = LEVELS[config.LOG_LEVEL];

const COLOR: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function ts(): string {
  const d = new Date(Date.now() + config.TZ_OFFSET_HOURS * 3600_000);
  return d.toISOString().slice(11, 19);
}

function emit(level: Level, msg: string, extra?: unknown) {
  if (LEVELS[level] < min) return;
  const tag = `${COLOR[level]}${level.padEnd(5)}${RESET}`;
  const line = `${'\x1b[90m'}${ts()}${RESET} ${tag} ${msg}`;
  if (extra === undefined) console.log(line);
  else console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
}

export const log = {
  debug: (m: string, e?: unknown) => emit('debug', m, e),
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
};
