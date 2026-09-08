/**
 * Проверка окружения. Запускать первым делом: npm run check
 * Ничего не меняет и никому не пишет — только читает и докладывает.
 */
import { config } from '../config.js';
import { linko } from '../linko/client.js';
import { getDb, isEmbeddedDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { sql } from 'drizzle-orm';
import { Bot } from 'grammy';
import { fmtSum } from '../lib/money.js';

const OK = '\x1b[32m✓\x1b[0m';
const NO = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const DIM = '\x1b[90m';
const R = '\x1b[0m';

function mask(s: string): string {
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

const problems: string[] = [];

async function main() {
  console.log(`\n${DIM}─────────────────────────────────────────────${R}`);
  console.log('  Проверка окружения AKM-бота');
  console.log(`${DIM}─────────────────────────────────────────────${R}\n`);

  console.log(`  Режим:      \x1b[1m${config.MODE}\x1b[0m${
    config.MODE === 'dry_run' ? `  ${DIM}(наружу ничего не уходит)${R}` :
    config.MODE === 'shadow'  ? `  ${DIM}(клиентам не пишем, сотрудникам да)${R}` :
    `  \x1b[31m(боевой — сообщения уходят по-настоящему)${R}`
  }`);
  console.log(`  Linko:      ${config.LINKO_BASE_URL}`);
  console.log(`  Токен:      ${mask(config.LINKO_TOKEN)}`);
  console.log(`  БД:         ${isEmbeddedDb ? 'встроенная PGlite' : 'внешний Postgres'} ${DIM}${config.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}${R}\n`);

  /* ── 1. База ── */
  try {
    const n = await migrate();
    const db = await getDb();
    const res = await db.execute(sql`SELECT count(*)::int AS c FROM markets`);
    const rows = (res as unknown as { rows?: { c: number }[] }).rows ?? (res as unknown as { c: number }[]);
    const cnt = Array.isArray(rows) ? (rows[0]?.c ?? 0) : 0;
    console.log(`${OK} База данных — схема на месте (${n} запросов), точек в зеркале: ${cnt}`);
  } catch (e) {
    console.log(`${NO} База данных — ${(e as Error).message}`);
    problems.push('БД недоступна');
  }

  /* ── 2. Linko ── */
  const ping = await linko.ping();
  if (ping.ok) {
    console.log(`${OK} Linko API — токен принят`);
    try {
      const [markets, orders] = await Promise.all([
        linko.markets({ limit: 1 }),
        linko.orders({ limit: 1 }),
      ]);
      const sample = orders[0];
      console.log(`${DIM}    точки доступны: ${markets.length > 0 ? 'да' : 'пусто'}, заказы: ${orders.length > 0 ? 'да' : 'пусто'}${R}`);
      if (sample) {
        console.log(`${DIM}    последний заказ №${sample.id} — ${sample.market?.name ?? '?'}, ${fmtSum(sample.total_price)}, статус ${sample.status}${R}`);
      }
    } catch (e) {
      console.log(`${WARN} Linko отвечает, но выборка не прошла: ${(e as Error).message}`);
    }
  } else {
    console.log(`${NO} Linko API — ${ping.error}`);
    problems.push('Linko недоступен');
  }

  /* ── 3. Telegram ── */
  if (!config.BOT_TOKEN) {
    console.log(`${WARN} Telegram — BOT_TOKEN не задан, проверяю только Linko и БД`);
    problems.push('Создайте бота в @BotFather и впишите BOT_TOKEN в .env');
  } else try {
    const bot = new Bot(config.BOT_TOKEN);
    const me = await bot.api.getMe();
    console.log(`${OK} Telegram — бот @${me.username} (${me.first_name})`);
    console.log(`${DIM}    Secretary Mode: ${me.can_connect_to_business ? 'включён' : 'ВЫКЛЮЧЕН'}${R}`);
    if (!me.can_connect_to_business) {
      problems.push('Включите Secretary Mode: @BotFather → /mybots → бот → Bot Settings → Secretary Mode. До мая 2026 назывался Business Mode — если видите старое название, это он же.');
    }

    const wh = await bot.api.getWebhookInfo();
    if (wh.url) {
      console.log(`${WARN} Установлен вебхук ${wh.url} — для локального запуска его надо снять`);
      problems.push('Снимите вебхук: он мешает long polling на тесте');
    }
  } catch (e) {
    console.log(`${NO} Telegram — ${(e as Error).message}`);
    problems.push('BOT_TOKEN не работает');
  }

  /* ── 4. Куда шлём ── */
  console.log('');
  const groups: [string, string][] = [
    ['Бухгалтерия (M1)', config.ACCOUNTANT_CHAT_ID],
    ['Финансы (M5)', config.FINANCE_CHAT_ID],
    ['Менеджеры (M3)', config.MANAGER_CHAT_ID],
  ];
  for (const [name, id] of groups) {
    if (id) console.log(`${OK} ${name}: ${id}`);
    else console.log(`${WARN} ${name}: не задана — уведомления никуда не пойдут`);
  }

  console.log('');
  if (config.BUSINESS_ALLOWLIST.length) {
    console.log(`${OK} Канал A: белый список из ${config.BUSINESS_ALLOWLIST.length} чатов (пилот)`);
  } else {
    console.log(`${WARN} Канал A: белый список пуст — бот ответит всем, кого пропустят настройки Business`);
  }
  if (config.BUSINESS_BLOCKLIST.length) {
    console.log(`${OK} Канал A: исключено чатов — ${config.BUSINESS_BLOCKLIST.length}`);
  }

  /* ── Итог ── */
  console.log(`\n${DIM}─────────────────────────────────────────────${R}`);
  if (problems.length === 0) {
    console.log(`  ${OK} Всё готово. Запускайте: \x1b[1mnpm run sync\x1b[0m, затем \x1b[1mnpm run dev\x1b[0m`);
  } else {
    console.log(`  ${WARN} Осталось разобраться:\n`);
    problems.forEach((p, i) => console.log(`     ${i + 1}. ${p}`));
  }
  console.log(`${DIM}─────────────────────────────────────────────${R}\n`);

  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\nПроверка упала:', (e as Error).message, '\n');
  process.exit(1);
});
