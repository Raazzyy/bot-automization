import type { Api } from 'grammy';
import { findDormantMarkets, postReactivationCards } from '../bot/reactivate.js';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

let cronInterval: NodeJS.Timeout | null = null;

/**
 * Запуск единичного сканирования спящих клиентов
 */
export async function scanAndNotifyDormantMarkets(api?: Api): Promise<{ scanned: number; posted: number }> {
  log.info('Запуск автономного сканирования спящих клиентов...');
  try {
    const dormantList = await findDormantMarkets();
    log.info(`Найдено ${dormantList.length} спящих клиентов, нарушивших цикл закупок.`);

    if (!api) {
      log.info('Api не передан — данные доступны для веб-панели управления.');
      return { scanned: dormantList.length, posted: 0 };
    }

    const posted = await postReactivationCards(api, config.ASSIST_CHAT_ID || config.MANAGER_CHAT_ID);
    log.info(`Опубликовано ${posted} карточек реактивации спящих клиентов.`);
    return { scanned: dormantList.length, posted };
  } catch (e) {
    log.error('Ошибка в сканере спящих клиентов:', e);
    return { scanned: 0, posted: 0 };
  }
}

/**
 * Запуск периодического фонового мониторинга спящих клиентов (по умолчанию каждые 12 часов)
 */
export function startSleepersCron(api?: Api, intervalHours = 12): void {
  if (cronInterval) clearInterval(cronInterval);

  const ms = intervalHours * 3600 * 1000;
  log.info(`Фоновый автопилот спящих клиентов запущен с интервалом ${intervalHours} ч.`);

  // Запуск фонового интервала
  cronInterval = setInterval(() => {
    scanAndNotifyDormantMarkets(api).catch((err) => {
      log.error('Ошибка планового сканирования спящих клиентов:', err);
    });
  }, ms);
}

export function stopSleepersCron(): void {
  if (cronInterval) {
    clearInterval(cronInterval);
    cronInterval = null;
    log.info('Фоновый автопилот спящих клиентов остановлен.');
  }
}
