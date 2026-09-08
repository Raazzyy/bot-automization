/**
 * Импорт списка номеров из «НОМЕРА ДЛЯ БОТА.xlsx».
 *
 *   npm run phones:import -- "НОМЕРА ДЛЯ БОТА.xlsx"
 *
 * Ничего никуда не отправляет. Разбирает файл, нормализует номера,
 * сверяет с точками в зеркале Linko и пишет два отчёта рядом с файлом.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { markets } from '../db/schema.js';
import { normalizePhone, formatPhone } from '../lib/phone.js';

const OK = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';

/** Минимальный парсер xlsx: распаковка + чтение XML. Без внешних зависимостей. */
function readColumnA(file: string): string[] {
  const work = join(tmpdir(), `akm-xlsx-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const zip = join(work, 'book.zip');
  copyFileSync(file, zip);

  // PowerShell есть на любой Windows; на других системах — unzip
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${work}' -Force`,
    ], { stdio: 'ignore' });
  } catch {
    execFileSync('unzip', ['-o', zip, '-d', work], { stdio: 'ignore' });
  }

  const ssPath = join(work, 'xl', 'sharedStrings.xml');
  const shared: string[] = [];
  if (existsSync(ssPath)) {
    const xml = readFileSync(ssPath, 'utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
    }
  }

  const sheet = readFileSync(join(work, 'xl', 'worksheets', 'sheet1.xml'), 'utf8');
  const out: string[] = [];
  for (const m of sheet.matchAll(/<c r="A(\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
    if (Number(m[1]) < 2) continue; // строка 1 — заголовок
    const v = /<v>([\s\S]*?)<\/v>/.exec(m[3]!)?.[1];
    if (v === undefined) continue;
    out.push(/t="s"/.test(m[2]!) ? (shared[Number(v)] ?? '') : v);
  }
  return out;
}

async function main() {
  const file = resolve(process.argv[2] ?? 'НОМЕРА ДЛЯ БОТА.xlsx');
  if (!existsSync(file)) {
    console.error(`Файл не найден: ${file}`);
    process.exit(1);
  }

  await migrate();
  const db = await getDb();

  const raw = readColumnA(file);
  const good = new Map<string, number>();   // E.164 → сколько раз встретился
  const bad: { row: number; raw: string; reason: string }[] = [];

  raw.forEach((value, i) => {
    const r = normalizePhone(value);
    if (r.ok) good.set(r.e164, (good.get(r.e164) ?? 0) + 1);
    else bad.push({ row: i + 2, raw: String(value), reason: r.reason });
  });

  // Сверка с точками Linko
  const allMarkets = await db.select().from(markets);
  const byPhone = new Map<string, { id: number; name: string }[]>();
  for (const m of allMarkets) {
    for (const p of m.phones ?? []) {
      const list = byPhone.get(p) ?? [];
      list.push({ id: m.id, name: m.name });
      byPhone.set(p, list);
    }
  }

  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const phone of good.keys()) {
    (byPhone.has(phone) ? matched : unmatched).push(phone);
  }

  console.log(`\n  Файл: ${file}\n`);
  console.log(`${OK} строк в файле: ${raw.length}`);
  console.log(`${OK} нормализовано: ${raw.length - bad.length}, уникальных: ${good.size}`);
  const dupes = [...good.entries()].filter(([, n]) => n > 1);
  if (dupes.length) {
    console.log(`${WARN} повторяются в файле: ${dupes.length} номеров`);
    dupes.sort((a, b) => b[1] - a[1]).slice(0, 5)
      .forEach(([p, n]) => console.log(`      ${formatPhone(p)} — ${n} раз`));
  }
  if (bad.length) console.log(`${WARN} требуют ручной правки: ${bad.length}`);

  if (allMarkets.length === 0) {
    console.log(`\n${WARN} Точек в зеркале нет — сверка с Linko пропущена.`);
    console.log(`      Сначала выполните: npm run sync`);
  } else {
    console.log(`\n${OK} нашлись в Linko: ${matched.length}`);
    console.log(`${WARN} нет в Linko: ${unmatched.length} — этим клиентам бот не сможет привязать точку`);
  }

  const dir = resolve('.data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'phones_ok.txt'), [...good.keys()].join('\n'), 'utf8');
  writeFileSync(
    join(dir, 'phones_problems.txt'),
    bad.map((b) => `строка ${b.row}\t${b.raw}\t${b.reason}`).join('\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'phones_not_in_linko.txt'), unmatched.join('\n'), 'utf8');

  console.log(`\n  Отчёты: .data/phones_ok.txt, phones_problems.txt, phones_not_in_linko.txt\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Импорт не прошёл:', (e as Error).message);
  process.exit(1);
});
