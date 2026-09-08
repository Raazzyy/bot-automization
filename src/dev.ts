/**
 * Локальный запуск для тестового аккаунта.
 * Long polling — публичный адрес и вебхуки не нужны.
 *
 *   npm run dev
 */
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { closeDb } from './db/index.js';
import { createBot } from './bot/index.js';
import { postNewOrders, postNewPayments } from './bot/esf.js';
import { syncAll } from './linko/sync.js';
import { log } from './lib/logger.js';

/** Эти типы апдейтов Telegram не присылает по умолчанию — их надо запросить явно */
const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
] as const;

let syncing = false;

async function syncTick(bot: ReturnType<typeof createBot> | null) {
  if (syncing) {
    log.debug('Предыдущая синхронизация ещё идёт — пропуск такта');
    return;
  }
  syncing = true;
  try {
    const results = await syncAll();
    const failed = results.filter((r) => r.error);
    const total = results.reduce((s, r) => s + r.rows, 0);

    if (failed.length) {
      log.warn(`Синхронизация: ${failed.length} из ${results.length} сущностей с ошибкой`);
    } else if (total > 0) {
      log.info(`Синхронизация: всего ${total} записей`);
    }

    // Новые данные — сразу проверяем, есть ли что публиковать бухгалтерам
    if (bot && total > 0) {
      await postNewOrders(bot.api);
      await postNewPayments(bot.api);
    }
  } finally {
    syncing = false;
  }
}

async function main() {
  log.info('Запуск AKM-бота');
  log.info(`Режим: ${config.MODE}`);

  await migrate();
  log.info('Схема БД готова');

  let bot: ReturnType<typeof createBot> | null = null;

  if (config.BOT_TOKEN) {
    bot = createBot();
    const me = await bot.api.getMe();
    log.info(`Telegram: @${me.username}`);

    if (!me.can_connect_to_business) {
      log.warn('У бота выключен Secretary Mode — канал A работать не будет.');
      log.warn('@BotFather → /mybots → бот → Bot Settings → Secretary Mode (раньше назывался Business Mode)');
    }

    // Снимаем вебхук, иначе long polling не заработает
    await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});

    void bot.start({
      allowed_updates: [...ALLOWED_UPDATES],
      onStart: () => log.info('Бот слушает обновления'),
    });
  } else {
    log.warn('BOT_TOKEN не задан — работает только синхронизация с Linko');
  }

  // Первый прогон сразу, дальше по расписанию
  await syncTick(bot);
  const timer = setInterval(() => void syncTick(bot), config.SYNC_INTERVAL_SEC * 1000);
  log.info(`Синхронизация каждые ${config.SYNC_INTERVAL_SEC} с`);

  const stop = async (signal: string) => {
    log.info(`${signal} — останавливаюсь`);
    clearInterval(timer);
    if (bot) await bot.stop();
    // Встроенную базу обязательно закрыть: убитый процесс оставляет
    // каталог в состоянии, из которого она больше не поднимется.
    await closeDb();
    log.info('База закрыта, до свидания');
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((e) => {
  log.error('Не удалось запуститься', (e as Error).message);
  process.exit(1);
});
