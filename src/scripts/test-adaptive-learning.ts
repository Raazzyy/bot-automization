import { findClientProfile, recordManagerFeedback, loadLearnedKnowledge } from '../ai/chat-learner.js';
import { buildContext } from '../ai/prompt.js';
import { log } from '../lib/logger.js';
import fs from 'node:fs';
import path from 'node:path';

async function runTests() {
  log.info('Тестирование адаптивной памяти и самообучения...');

  const knowledge = loadLearnedKnowledge();
  if (!knowledge) {
    throw new Error('Не удалось загрузить learned-knowledge.json');
  }
  log.info(`База знаний загружена: ${knowledge.clientProfiles.length} профилей клиентов, ${knowledge.extractedAliases.length} синонимов, ${knowledge.goldenDialogues.length} диалогов`);

  const profileKnown1 = findClientProfile({ clientName: 'I L' });
  const profileKnown2 = findClientProfile({ clientName: 'Искандер' });
  const profileKnown3 = findClientProfile({ marketName: 'BESHYOGOCH QAHVA' });

  if (!profileKnown1 || !profileKnown2 || !profileKnown3) {
    throw new Error('Не удалось найти профили клиентов по имени или точке');
  }
  log.info(`Профиль клиента найден (I L / Beshyogoch): товары -> ${profileKnown1.typicalProducts.join(', ')}`);
  log.info(`Профиль клиента найден (Искандер): специфика -> ${profileKnown2.notes}`);

  const ctxKnown = buildContext({
    clientName: 'I L',
    marketName: 'BESHYOGOCH QAHVA',
    marketId: 42,
    lang: 'uz',
    clientProfile: profileKnown1,
    isNewClient: false,
  });

  if (!ctxKnown.includes('ПЕРСОНАЛЬНЫЙ ПРОФИЛЬ КЛИЕНТА') || !ctxKnown.includes('Тунец Dardanel 160г')) {
    throw new Error('В контексте постоянного клиента отсутствует персональный профиль или товары');
  }
  log.info('Системный контекст для постоянного клиента сгенерирован успешно');

  const ctxNew = buildContext({
    clientName: 'Новый Ресторан',
    marketName: null,
    lang: 'ru',
    clientProfile: null,
    isNewClient: true,
  });

  if (!ctxNew.includes('СТАТУС: НОВЫЙ КЛИЕНТ') || !ctxNew.includes('Это первый контакт')) {
    throw new Error('В контексте нового клиента отсутствует директива онбординга');
  }
  log.info('Системный контекст для нового клиента сгенерирован успешно');

  recordManagerFeedback({
    chatId: -100998877,
    clientName: 'Тестовый Клиент',
    clientText: 'Сделайте скидку 10%',
    managerActualText: 'У нас цены с НДС окончательные, но при объеме от 10 блоков согласуем бесплатную доставку',
  });

  const feedbackFile = path.resolve('src/ai/manager-feedback.json');
  if (!fs.existsSync(feedbackFile)) {
    throw new Error('Файл manager-feedback.json не найден');
  }
  const feedbackData = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'));
  const found = feedbackData.find((f: any) => f.chatId === -100998877);
  if (!found || !found.managerActualText.includes('бесплатную доставку')) {
    throw new Error('Запись обратной связи менеджера не найдена');
  }
  log.info('Обратная связь менеджера зафиксирована в feedback loop');

  log.info('Все тесты адаптивной памяти и обучения успешно пройдены.');
}

runTests().catch((err) => {
  console.error('Ошибка тестов:', err);
  process.exit(1);
});

