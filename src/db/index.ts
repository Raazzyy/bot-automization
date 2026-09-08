import { config } from '../config.js';
import * as schema from './schema.js';

/**
 * Одна схема — две среды.
 *   pglite://<путь>  — встроенный Postgres в файле, ничего ставить не надо (тест)
 *   postgres://...   — обычный Postgres: Neon, Supabase, свой сервер (бой)
 */

type Db = Awaited<ReturnType<typeof create>>;

async function create() {
  const url = config.DATABASE_URL;

  if (url.startsWith('pglite://')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { mkdirSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');

    const dir = resolve(url.replace('pglite://', ''));
    // PGlite сам родительский каталог не создаёт
    mkdirSync(dirname(dir), { recursive: true });

    const client = new PGlite(dir);
    await client.waitReady;
    return drizzle(client, { schema });
  }

  const pg = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pool = new pg.default.Pool({
    connectionString: url,
    ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  return drizzle(pool, { schema });
}

let instance: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  instance ??= create();
  return instance;
}

export { schema };
export const isEmbeddedDb = config.DATABASE_URL.startsWith('pglite://');
