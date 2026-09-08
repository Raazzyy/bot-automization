/** Разовая синхронизация с Linko: npm run sync */
import { migrate } from '../db/migrate.js';
import { syncAll } from '../linko/sync.js';
import { log } from '../lib/logger.js';

const OK = '\x1b[32m✓\x1b[0m';
const NO = '\x1b[31m✗\x1b[0m';

async function main() {
  await migrate();
  const results = await syncAll();

  console.log('');
  for (const r of results) {
    const mark = r.error ? NO : OK;
    const tail = r.error
      ? `\x1b[31m${r.error}\x1b[0m`
      : `${r.rows} записей за ${r.ms} мс${r.toTm > r.fromTm ? `, курсор → ${r.toTm}` : ''}`;
    console.log(`${mark} ${r.entity.padEnd(11)} ${tail}`);
  }

  const failed = results.filter((r) => r.error).length;
  console.log('');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  log.error('Синхронизация упала', (e as Error).message);
  process.exit(1);
});
