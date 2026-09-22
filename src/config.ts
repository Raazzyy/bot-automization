import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

const idList = z.string().default('').transform((s) =>
  s.split(',').map((x) => x.trim()).filter(Boolean),
);

const schema = z.object({
  LINKO_BASE_URL: z.string().url().default('https://akm.linko.uz'),
  LINKO_TOKEN: z.string().min(10, 'LINKO_TOKEN не задан'),

  BOT_TOKEN: z.string().default('').refine(
    (v) => v === '' || /^\d+:[\w-]+$/.test(v),
    'BOT_TOKEN выглядит неверно — ожидается формат 1234567890:AA...',
  ),

  ACCOUNTANT_CHAT_ID: z.string().default(''),
  FINANCE_CHAT_ID: z.string().default(''),
  MANAGER_CHAT_ID: z.string().default(''),

  BUSINESS_ALLOWLIST: idList,
  BUSINESS_BLOCKLIST: idList,

  MODE: z.enum(['dry_run', 'shadow', 'assist', 'live']).default('dry_run'),

  ASSIST_CHAT_ID: z.string().default(''),

  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),

  DATABASE_URL: z.string().default('pglite://.data/akm'),
  SYNC_INTERVAL_SEC: z.coerce.number().int().min(30).default(120),
  TZ_OFFSET_HOURS: z.coerce.number().default(5),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  PORT: z.coerce.number().default(3000),

  SESSION_SECRET: z.string().default(''),

  DISABLE_BOT_POLLING: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true' || v === '1' || v.toLowerCase() === 'yes'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('\n  Ошибка конфигурации (.env):\n');
  for (const issue of parsed.error.issues) {
    console.error(`   • ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\n  Скопируйте .env.example в .env и заполните значения.\n');
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

export const isLive = config.MODE === 'live';
export const isAssist = config.MODE === 'assist';
export const canSendToClients = config.MODE === 'live';
export const canSendToStaff = config.MODE !== 'dry_run';
