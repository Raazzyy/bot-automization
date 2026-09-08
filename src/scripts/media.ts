/**
 * Библиотека файлов: прайсы, фото, ролики.
 *
 *   npm run media          — показать, что зарегистрировано
 *   npm run media -- sync  — загрузить список из media.json
 *
 * Файлы кладутся в папку media/, их описание — в media.json.
 * Образец: media.example.json
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate } from '../db/migrate.js';
import { getDb, closeDb } from '../db/index.js';
import { mediaFiles } from '../db/schema.js';

const OK = '\x1b[32m✓\x1b[0m';
const NO = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const DIM = '\x1b[90m';
const R = '\x1b[0m';

const KINDS = ['document', 'photo', 'video', 'voice'] as const;

interface Entry {
  key: string;
  kind: string;
  title: string;
  description?: string;
  keywords?: string[];
  path: string;
  caption?: string;
  active?: boolean;
}

function human(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

async function list() {
  const db = await getDb();
  const rows = await db.select().from(mediaFiles);

  if (!rows.length) {
    console.log(`\n${WARN} Библиотека пуста.\n`);
    console.log(`  1. Скопируйте media.example.json в media.json`);
    console.log(`  2. Положите файлы в папку media/`);
    console.log(`  3. Выполните: npm run media -- sync\n`);
    return;
  }

  console.log(`\n  Зарегистрировано файлов: ${rows.length}\n`);
  for (const r of rows) {
    const onDisk = r.path && existsSync(r.path);
    const mark = !r.isActive ? WARN : (r.fileId || onDisk) ? OK : NO;
    console.log(`${mark} ${r.key}  ${DIM}(${r.kind})${R}`);
    console.log(`    ${r.title}${r.description ? ` — ${r.description}` : ''}`);
    if (r.keywords?.length) console.log(`    ${DIM}просят так: ${r.keywords.join(', ')}${R}`);
    console.log(`    ${DIM}${r.fileId ? 'загружен в Telegram, уйдёт мгновенно' : onDisk ? `на диске: ${r.path}` : `ФАЙЛА НЕТ: ${r.path}`}`
      + `${r.sentCount ? ` · отправлен ${r.sentCount} раз` : ''}${R}`);
    console.log('');
  }
}

async function sync() {
  const file = resolve('media.json');
  if (!existsSync(file)) {
    console.error(`\n${NO} Нет файла media.json`);
    console.error(`   Скопируйте media.example.json в media.json и опишите свои файлы.\n`);
    process.exit(1);
  }

  let entries: Entry[];
  try {
    entries = JSON.parse(readFileSync(file, 'utf8')) as Entry[];
  } catch (e) {
    console.error(`\n${NO} media.json не читается: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const db = await getDb();
  let added = 0, updated = 0;
  const problems: string[] = [];

  for (const e of entries) {
    if (!e.key || !e.path || !e.title) {
      problems.push(`запись без key/path/title: ${JSON.stringify(e).slice(0, 60)}`);
      continue;
    }
    if (!KINDS.includes(e.kind as typeof KINDS[number])) {
      problems.push(`${e.key}: тип «${e.kind}» неизвестен, допустимы ${KINDS.join(', ')}`);
      continue;
    }

    const path = resolve(e.path);
    if (!existsSync(path)) {
      problems.push(`${e.key}: файла нет — ${e.path}`);
      continue;
    }

    const size = statSync(path).size;
    if (size > 50 * 1024 * 1024) {
      problems.push(`${e.key}: ${human(size)} — Telegram не примет больше 50 МБ`);
      continue;
    }

    const [prev] = await db.select().from(mediaFiles).where(eq(mediaFiles.key, e.key)).limit(1);

    await db.insert(mediaFiles).values({
      key: e.key,
      kind: e.kind,
      title: e.title,
      description: e.description ?? null,
      keywords: e.keywords ?? [],
      path,
      caption: e.caption ?? null,
      isActive: e.active !== false,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: mediaFiles.key,
      set: {
        kind: e.kind, title: e.title,
        description: e.description ?? null,
        keywords: e.keywords ?? [],
        path,
        caption: e.caption ?? null,
        isActive: e.active !== false,
        // Путь изменился — старый file_id больше не годится
        ...(prev && prev.path !== path ? { fileId: null } : {}),
        updatedAt: new Date(),
      },
    });

    if (prev) updated++; else added++;
    console.log(`${OK} ${e.key} ${DIM}(${human(size)})${R}`);
  }

  console.log(`\n  Добавлено: ${added}, обновлено: ${updated}`);
  if (problems.length) {
    console.log(`\n${WARN} Не приняты:`);
    problems.forEach((p) => console.log(`    ${p}`));
  }
  console.log('');
}

async function main() {
  await migrate();
  if (process.argv.includes('sync')) await sync();
  else await list();
  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error('\nОшибка:', (e as Error).message, '\n');
  process.exit(1);
});
