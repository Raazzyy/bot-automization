import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { orders, orderItems, markets, payments } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { buildOrderCard } from '../bot/esf.js';
import { calculateDebts, buildDebtSummaryText, buildDebtKeyboard } from '../bot/debts.js';
import { postReactivationCards } from '../bot/reactivate.js';
import { generateWaybillPdf, generateReconciliationPdf } from '../lib/pdf-waybill.js';
import { log } from '../lib/logger.js';

const TARGET_CHAT = config.ACCOUNTANT_CHAT_ID || '-1004435807678';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const token = config.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN не задан');

  const bot = new Bot(token);
  const db = await getDb();

  console.log(`Запуск сквозного прогона в чат ${TARGET_CHAT}...`);

  await bot.api.sendMessage(
    TARGET_CHAT,
    [
      '<b>AKM HOLDINGS INC · Комплексный прогон сценариев</b>',
      '',
      'Дистрибьюция продуктов питания (HoReCa / Ритейл).',
      'Ниже представлены тестовые карточки и документы по направлениям:',
      '',
      '1. <b>Бухгалтерия (М1):</b> Карточка заказа к выставлению ЭСФ + накладная в PDF.',
      '2. <b>Финотдел (М5):</b> Анализ дебиторки и старения долгов + акт сверки в PDF.',
      '3. <b>Отдел продаж (М4):</b> Поиск спящих клиентов по циклу покупок + офферы.',
      '4. <b>Логистика (М2/М3):</b> Заказ в свободной форме, навигация Яндекс Карты, накладная.',
      '5. <b>Новые клиенты (OCR):</b> Распознавание реквизитов (Гувохнома, р/с, МФО, ПИНФЛ).',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );

  await sleep(1500);

  console.log('1. Сценарий М1: ЭСФ и Накладная PDF...');
  let targetOrderId = -101;
  const [existingOrder] = await db.select().from(orders).where(eq(orders.id, targetOrderId)).limit(1);

  if (!existingOrder) {
    const [anyOrder] = await db.select().from(orders).orderBy(desc(orders.id)).limit(1);
    if (anyOrder) targetOrderId = anyOrder.id;
  }

  const orderCardText = await buildOrderCard(targetOrderId);
  if (orderCardText) {
    const esfKb = new InlineKeyboard()
      .text('ЭСФ выставлен', `esf:issued:${targetOrderId}`)
      .text('Состав', `esf:items:${targetOrderId}`)
      .row()
      .text('Накладная PDF', `esf:pdf:${targetOrderId}`)
      .text('Проблема', `esf:problem:${targetOrderId}`);

    await bot.api.sendMessage(TARGET_CHAT, orderCardText, {
      parse_mode: 'HTML',
      reply_markup: esfKb,
    });

    await sleep(1000);

    try {
      const waybillBuf = await generateWaybillPdf(targetOrderId);
      const safeMName = (existingOrder?.marketName || 'Клиент').replace(/[«»"']/g, '').trim().replace(/\s+/g, '_').replace(/[^\wа-яёА-ЯЁ0-9_-]/gi, '');
      await bot.api.sendDocument(
        TARGET_CHAT,
        new InputFile(waybillBuf, `Накладная_${safeMName}_№${targetOrderId}.pdf`),
        {
          caption: `<b>Товарная накладная к заказу №${targetOrderId} («${existingOrder?.marketName ?? 'Клиент'}»)</b>\nПоставщик: ООО «AKM HOLDINGS INC»`,
          parse_mode: 'HTML',
        },
      );
    } catch (e) {
      console.error('Ошибка создания PDF накладной:', e);
    }
  }

  await sleep(2000);

  console.log('2. Сценарий М5: Дебиторка и Акт сверки PDF...');
  const debtOverview = await calculateDebts();
  const debtText = buildDebtSummaryText(debtOverview);
  const debtKb = buildDebtKeyboard(debtOverview.debtors);

  await bot.api.sendMessage(TARGET_CHAT, debtText, {
    parse_mode: 'HTML',
    reply_markup: debtKb,
  });

  await sleep(1000);

  const debtorMarketId = debtOverview.debtors[0]?.marketId ?? -5;
  const [debtorMarket] = await db.select().from(markets).where(eq(markets.id, debtorMarketId)).limit(1);
  const debtorName = debtorMarket?.name ?? 'Caravan';

  try {
    const actBuf = await generateReconciliationPdf(debtorMarketId);
    await bot.api.sendDocument(
      TARGET_CHAT,
      new InputFile(actBuf, `Акт_сверки_${debtorName.replace(/[^\wа-яё]/gi, '_')}.pdf`),
      {
        caption: `<b>Акт сверки взаимных расчетов · «${debtorName}»</b>\nПериод: текущий баланс\nПоставщик: ООО «AKM HOLDINGS INC»`,
        parse_mode: 'HTML',
      },
    );
  } catch (e) {
    console.error('Ошибка создания PDF акта сверки:', e);
  }

  await sleep(2000);

  console.log('3. Сценарий М4: Спящие клиенты...');
  await postReactivationCards(bot.api, TARGET_CHAT);

  await sleep(2000);

  console.log('4. Сценарий М2/М3: Заказ HoReCa с маршрутом...');
  const orderReqText = [
    '<b>Заказ №51</b> (новое)',
    '',
    'От: <b>Шеф-повар Алишер</b> (@alisher_chef)',
    '',
    '<i>«Ассалому алейкум! На завтра на утро для Ресторана «Caravan City» нужно 24 банки тунца Dardanel и 6 банок томатной пасты Burcu 830 г. Адрес: г. Ташкент, ул. Амира Темура, 15. До 11:00 успеете?»</i>',
    '',
    '<b>Ресторан «Caravan City»</b>',
    '  • Тунец кусочками в собственном соку Dardanel 150 г — 24 бан',
    '  • Томатная паста Burcu 830 г ж/б — 6 бан',
    '',
    '<b>Вопросы:</b>',
    '  — До 11:00 успеете?',
    '',
    '<b>Статус:</b>',
    '  Подтверждение приёма заказа отправлено клиенту',
    '',
    '<i>Ответьте текстом или выберите вариант:</i>',
  ].join('\n');

  const orderReqKb = new InlineKeyboard()
    .text('Завтра к 11:00', 'req:quick:51:tomorrow_11')
    .text('Сегодня до 18:00', 'req:quick:51:today_18')
    .row()
    .text('На сборке', 'req:quick:51:warehouse')
    .text('Накладная PDF', 'req:pdf:51')
    .row()
    .url('Маршрут (Яндекс Карты)', 'https://yandex.uz/maps/?text=' + encodeURIComponent('г. Ташкент, ул. Амира Темура, 15'))
    .row()
    .text('Готово', 'req:done:51');

  await bot.api.sendMessage(TARGET_CHAT, orderReqText, {
    parse_mode: 'HTML',
    reply_markup: orderReqKb,
  });

  await sleep(2000);

  console.log('5. Сценарий OCR: Документы нового клиента...');
  const ocrCardText = [
    '<b>Документы №52</b> (новое)',
    '',
    'От: <b>Дильшод Рахимов</b> (@dilshod_rakhimov)',
    'Прислал: <b>документ (PDF Гувохнома)</b>',
    '',
    '<i>«Здравствуйте! Высылаю наши уставные документы для заключения договора на поставку.»</i>',
    '',
    '<b>Данные из документа (Гувохнома о регистрации):</b>',
    '  • Организация: <b>ООО "BASILIC RESTAURANT"</b>',
    '  • ИНН: <code>302494634</code>',
    '  • Р/С: <code>20208000700543219001</code>',
    '  • Банк: АКБ "HAMKORBANK" (МФО <code>00083</code>)',
    '  • ФИО / Директор: <b>Касимов Бахтиёр Алишерович</b>',
    '  • ПИНФЛ: <code>31205841230045</code>',
    '  • Адрес: г. Ташкент, Яккасарайский район, ул. Шота Руставели, 42',
    '',
    '<b>Статус:</b>',
    '  Получение документов подтверждено клиенту',
    '',
    '<i>Ответьте текстом или выберите вариант:</i>',
  ].join('\n');

  const ocrKb = new InlineKeyboard()
    .text('Договор готовим', 'req:quick:52:doc_preparing')
    .text('Реквизиты приняты', 'req:quick:52:doc_ok')
    .row()
    .url('Маршрут (Яндекс Карты)', 'https://yandex.uz/maps/?text=' + encodeURIComponent('г. Ташкент, Яккасарайский район, ул. Шота Руставели, 42'))
    .row()
    .text('Взять в работу', 'req:take:52')
    .text('Готово', 'req:done:52');

  await bot.api.sendMessage(TARGET_CHAT, ocrCardText, {
    parse_mode: 'HTML',
    reply_markup: ocrKb,
  });

  await sleep(1500);

  await bot.api.sendMessage(
    TARGET_CHAT,
    [
      '<b>Все сценарии успешно выгружены</b>',
      '',
      '• Откройте файлы накладной и акта сверки PDF для проверки реквизитов и печатей.',
      '• Кнопка «Маршрут» открывает точку в Яндекс Картах для доставки.',
      '• Инлайн-кнопки и быстрые ответы доступны для проверки.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );

  console.log('Прогон успешно завершен.');
}

main().catch((err) => {
  console.error('Ошибка выполнения прогона:', err);
  process.exit(1);
});
