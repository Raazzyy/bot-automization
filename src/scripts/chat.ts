/**
 * Уровень 1: диалог с моделью в терминале, без Telegram.
 *
 *   npm run chat
 *
 * Работает на демо-каталоге. Видно, какие инструменты модель вызвала
 * и что они вернули — сразу заметно, если она придумывает цены.
 */
import { createInterface } from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { markets } from '../db/schema.js';
import { runAgent } from '../ai/agent.js';
import { config } from '../config.js';

const C = {
  dim: '\x1b[90m', bold: '\x1b[1m', reset: '\x1b[0m',
  green: '\x1b[32m', blue: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m',
};

async function main() {
  if (!config.GEMINI_API_KEY) {
    console.error(`\n${C.red}GEMINI_API_KEY не задан.${C.reset}`);
    console.error(`Возьмите ключ на aistudio.google.com → Get API key`);
    console.error(`и впишите в .env строкой  GEMINI_API_KEY=...\n`);
    process.exit(1);
  }

  await migrate();
  const db = await getDb();

  // Играем за клиента первой демо-точки
  const [market] = await db.select().from(markets).where(eq(markets.id, -1)).limit(1);
  if (!market) {
    console.error(`\n${C.red}Нет демо-данных.${C.reset} Сначала: npm run seed\n`);
    process.exit(1);
  }

  console.log(`\n${C.dim}─────────────────────────────────────────────${C.reset}`);
  console.log(`  ${C.bold}Диалог с моделью${C.reset}  ${C.dim}(${config.GEMINI_MODEL})${C.reset}`);
  console.log(`  Вы играете клиента: ${C.bold}${market.name}${C.reset}`);
  console.log(`${C.dim}  Пустая строка или «выход» — закончить${C.reset}`);
  console.log(`${C.dim}─────────────────────────────────────────────${C.reset}\n`);
  console.log(`${C.dim}  Попробуйте: «масло почём?», «yog' bormi?», «мой прошлый заказ»,`);
  console.log(`  «дай скидку 30%», «сколько я вам должен»${C.reset}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: { role: 'user' | 'model'; text: string }[] = [];

  for (;;) {
    const q = (await rl.question(`${C.green}вы  ›${C.reset} `)).trim();
    if (!q || /^(выход|exit|quit|q)$/i.test(q)) break;

    const started = Date.now();
    const turn = await runAgent({
      message: q,
      channel: 'A',
      ctx: { marketId: market.id },
      clientName: 'Азиз',
      marketName: market.name,
      history,
    });
    const ms = Date.now() - started;

    for (const t of turn.toolCalls) {
      console.log(`${C.dim}      ⚙ ${t.name}(${JSON.stringify(t.args)})${C.reset}`);
      for (const line of t.result.split('\n').slice(0, 4)) {
        console.log(`${C.dim}        ${line}${C.reset}`);
      }
    }

    if (turn.error) {
      console.log(`${C.red}      ошибка: ${turn.error}${C.reset}\n`);
      continue;
    }

    if (turn.handoff) {
      console.log(`${C.yellow}      → передано менеджеру: ${turn.handoff}${C.reset}`);
    }

    if (turn.attachments.length) {
      console.log(`${C.yellow}      📎 приложит файлы: ${turn.attachments.join(', ')}${C.reset}`);
    }
    console.log(`${C.blue}бот ›${C.reset} ${turn.reply || '(промолчал)'}`);
    console.log(`${C.dim}      ${ms} мс${C.reset}\n`);

    history.push({ role: 'user', text: q });
    history.push({ role: 'model', text: turn.reply });
    while (history.length > 12) history.shift();
  }

  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('\nОшибка:', (e as Error).message, '\n');
  process.exit(1);
});
