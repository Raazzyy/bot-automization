import { config } from '../config.js';
import * as schema from './schema.js';

type Db = Awaited<ReturnType<typeof create>>;

async function create() {
  const url = config.DATABASE_URL;

  if (url.startsWith('pglite://')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { mkdirSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');

    const dir = resolve(url.replace('pglite://', ''));
    mkdirSync(dirname(dir), { recursive: true });

    try {
      const client = new PGlite(dir);
      await client.waitReady;
      pglite = client;
      return drizzle(client, { schema });
    } catch (e) {
      throw new Error(
        `Встроенная база в «${dir}» не открылась. Две обычные причины:\n`
        + '   1. Параллельно запущен другой процесс — например «npm run dev».\n'
        + '      PGlite открывается только одним процессом, остановите второй.\n'
        + '   2. База повреждена жёсткой остановкой процесса.\n'
        + '      Лечится так: удалить каталог .data и выполнить «npm run seed».\n'
        + '   В бою этого нет: там обычный Postgres (DATABASE_URL=postgres://...).\n'
        + `   Исходная ошибка: ${(e as Error).message}`,
      );
    }
  }

  const pg = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pool = new pg.default.Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  return drizzle(pool, { schema });
}

let pglite: { close: () => Promise<void> } | null = null;
let instance: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  instance ??= create();
  return instance;
}

export async function closeDb(): Promise<void> {
  if (pglite) {
    try { await pglite.close(); } catch {}
    pglite = null;
  }
  instance = null;
}

export { schema };
export const isEmbeddedDb = config.DATABASE_URL.startsWith('pglite://');
