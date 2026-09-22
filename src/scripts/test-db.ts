import { sql } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, closeDb, isEmbeddedDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { requests } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const OK = '\x1b[32m✓\x1b[0m';
const NO = '\x1b[31m✗\x1b[0m';
const DIM = '\x1b[90m';
const R = '\x1b[0m';

async function main() {
  console.log(`\n  Проверка базы: ${DIM}${config.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}${R}`);

  if (isEmbeddedDb) {
    console.log(`\n${NO} Это встроенная база (pglite://), а не боевой Postgres.`);
    console.log(`  Запускайте так:  DATABASE_URL=postgres://... npm run test:db\n`);
    process.exit(1);
  }

  const db = await getDb();
  await db.execute(sql`select 1`);
  console.log(`${OK} подключение`);

  const n = await migrate();
  console.log(`${OK} схема создана (${n} запросов)`);

  const [row] = await db.insert(requests).values({
    chatId: -999, clientName: 'ТЕСТ', text: 'проверка боевой базы', status: 'new',
  }).returning();
  if (!row) throw new Error('вставка не вернула строку');
  console.log(`${OK} запись (обращение №${row.id})`);

  const [back] = await db.select().from(requests).where(eq(requests.id, row.id)).limit(1);
  if (back?.clientName !== 'ТЕСТ') throw new Error('прочитали не то, что записали');
  console.log(`${OK} чтение`);

  await db.delete(requests).where(eq(requests.id, row.id));
  console.log(`${OK} удаление`);

  await closeDb();
  console.log(`\n  ${OK} Боевая база готова. На Neon/Replit заработает так же.\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n${NO} ${(e as Error).message}\n`);
  console.error(`  ${DIM}Проверьте строку DATABASE_URL и доступность сервера.${R}\n`);
  process.exit(1);
});
