/** Какие модели доступны нашему ключу: npm run models */
import { listModels } from '../ai/agent.js';
import { config } from '../config.js';

async function main() {
  if (!config.GEMINI_API_KEY) {
    console.error('\nGEMINI_API_KEY не задан.\n');
    process.exit(1);
  }

  const all = await listModels();
  const usable = all.filter((m) => m.methods.includes('generateContent'));

  console.log(`\n  Доступно моделей: ${usable.length}`);
  console.log(`  Сейчас в .env:    ${config.GEMINI_MODEL}\n`);

  const flash = usable.filter((m) => /flash|lite/i.test(m.name));
  console.log('  Подходящие нам (Flash / Lite — дёшево и быстро):');
  for (const m of flash) {
    const mark = m.name === config.GEMINI_MODEL ? ' ← выбрана' : '';
    console.log(`    ${m.name}${mark}`);
  }

  const rest = usable.filter((m) => !/flash|lite/i.test(m.name));
  if (rest.length) {
    console.log(`\n  Остальные (${rest.length}): ${rest.slice(0, 8).map((m) => m.name).join(', ')}${rest.length > 8 ? ' …' : ''}`);
  }
  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nНе удалось получить список:', (e as Error).message, '\n');
  process.exit(1);
});
