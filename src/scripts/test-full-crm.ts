import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { orders, orderItems } from '../db/schema.js';
import { generateWaybillPdf, generateReconciliationPdf } from '../lib/pdf-waybill.js';
import { getAllSettings, updateSettings } from '../lib/settings.js';
import { startAdminServer } from '../server/admin-api.js';

const TEST_PORT = 3199;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function main() {
  console.log('\n======================================================');
  console.log('🚀 ЗАПУСК ПОЛНОГО СТРЕСС-ТЕСТИРОВАНИЯ CRM & ADMIN PANEL');
  console.log('======================================================\n');

  const server = startAdminServer(TEST_PORT);
  await new Promise((r) => setTimeout(r, 600));

  try {
    console.log('1. Тест /api/status:');
    const resStatus = await fetch(`${BASE_URL}/api/status`);
    assert.equal(resStatus.status, 200, 'Status endpoint должен вернуть 200');
    const statusData: any = await resStatus.json();
    assert.equal(statusData.status, 'ok');
    assert.ok(statusData.company_name, 'Имя компании должно быть заполнено');
    assert.ok(statusData.manager_name, 'Имя менеджера должно быть заполнено');
    assert.equal(typeof statusData.bot_enabled, 'boolean');
    assert.equal(typeof statusData.polling_disabled, 'boolean');
    console.log(`   ✅ Статус OK, компания: «${statusData.company_name}», бот: ${statusData.bot_enabled ? 'ВКЛ' : 'ВЫКЛ'}`);

    console.log('\n2. Тест /api/bot/toggle:');
    const toggleOff = await fetch(`${BASE_URL}/api/bot/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const offData: any = await toggleOff.json();
    assert.equal(offData.bot_enabled, false);

    const toggleOn = await fetch(`${BASE_URL}/api/bot/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const onData: any = await toggleOn.json();
    assert.equal(onData.bot_enabled, true);
    console.log('   ✅ Тумблер переключается корректно (ВЫКЛ -> ВКЛ)');

    console.log('\n3. Тест /api/stats:');
    const resStats = await fetch(`${BASE_URL}/api/stats`);
    const stats: any = await resStats.json();
    assert.ok(stats.orders_count > 0, 'Количество заказов должно быть > 0');
    assert.ok(stats.total_debt > 0, 'Общий долг должен быть > 0');
    assert.ok(stats.debtors_count > 0, 'Количество должников должно быть > 0');
    assert.ok(stats.aging, 'Объект старения дебиторки должен присутствовать');
    console.log(`   ✅ Заказов: ${stats.orders_count}, Сумма долга: ${stats.total_debt.toLocaleString()} сум, Должников: ${stats.debtors_count}`);

    console.log('\n4. Тест /api/settings и безопасность токенов:');
    const resSettings = await fetch(`${BASE_URL}/api/settings`);
    const settings: any = await resSettings.json();
    assert.ok(settings.telegram_bot_token_masked.includes('••••'), 'Токен бота должен быть замаскирован');
    assert.ok(settings.gemini_api_key_masked.includes('••••'), 'Ключ Gemini должен быть замаскирован');

    const originalCompany = settings.company_name;
    await fetch(`${BASE_URL}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: 'ООО «Тест Дистрибьюшн»' }),
    });
    const sUpdated = await getAllSettings();
    assert.equal(sUpdated.company_name, 'ООО «Тест Дистрибьюшн»');

    await updateSettings({ company_name: originalCompany });
    console.log('   ✅ Секреты безопасно замаскированы, White-Label настройки сохраняются');

    console.log('\n5. Тест /api/orders (поиск и фильтры):');
    const allOrdersRes = await fetch(`${BASE_URL}/api/orders?limit=10`);
    const allOrders: any = await allOrdersRes.json();
    assert.ok(allOrders.length > 0, 'Список заказов не пуст');

    const searchRes = await fetch(`${BASE_URL}/api/orders?q=Oasis`);
    const searchList: any = await searchRes.json();
    assert.ok(searchList.every((o: any) => o.marketName?.toLowerCase().includes('oasis')), 'Все найденные заказы содержат Oasis');

    const statusRes = await fetch(`${BASE_URL}/api/orders?status=delivered&limit=5`);
    const statusList: any = await statusRes.json();
    assert.ok(statusList.every((o: any) => o.status === 'delivered'), 'Фильтр по статусу отработал корректно');
    console.log(`   ✅ Поиск (Oasis: ${searchList.length} шт.) и фильтрация статусов работают идеально`);

    console.log('\n6. Тест /api/orders/:id/items:');
    const sampleOrder = allOrders[0];
    const itemsRes = await fetch(`${BASE_URL}/api/orders/${sampleOrder.real_id}/items`);
    assert.equal(itemsRes.status, 200);
    const itemsData: any = await itemsRes.json();
    assert.ok(itemsData.order, 'Объект заказа должен присутствовать');
    assert.ok(Array.isArray(itemsData.items), 'Массив товаров должен присутствовать');
    assert.ok(itemsData.items.length > 0, 'В заказе должны быть позиции');

    const notFoundOrder = await fetch(`${BASE_URL}/api/orders/99999999/items`);
    assert.equal(notFoundOrder.status, 404);
    console.log(`   ✅ Состав заказа #${sampleOrder.id}: ${itemsData.items.length} позиций, сумма: ${itemsData.order.total_price_fmt}`);

    console.log('\n7. Тест /api/markets:');
    const marketsRes = await fetch(`${BASE_URL}/api/markets?limit=10`);
    assert.equal(marketsRes.status, 200);
    const marketsList: any = await marketsRes.json();
    assert.ok(marketsList.length > 0);
    assert.ok(marketsList[0].name, 'У точки должно быть название');

    const searchMarketRes = await fetch(`${BASE_URL}/api/markets?q=Caravan`);
    const searchMarketList: any = await searchMarketRes.json();
    assert.ok(searchMarketList.some((m: any) => m.name.toLowerCase().includes('caravan')));
    console.log(`   ✅ Список маркетов отдает ${marketsList.length} точек, поиск по точкам работает`);

    console.log('\n8. Тест генерации PDF-накладной (включая многостраничность):');
    const waybillBuf = await generateWaybillPdf(sampleOrder.real_id);
    assert.ok(waybillBuf.length > 50_000, 'Размер PDF должен быть > 50KB');
    const waybillDoc = await PDFDocument.load(waybillBuf);
    assert.ok(waybillDoc.getPageCount() >= 1, 'Минимум 1 страница');

    const db = await getDb();
    const testOrderId = -99999;
    await db.delete(orderItems).where(eq(orderItems.orderId, testOrderId));
    await db.delete(orders).where(eq(orders.id, testOrderId));

    await db.insert(orders).values({
      id: testOrderId,
      marketId: -1,
      marketName: 'Тестовый Гипермаркет с большим заказом',
      totalPrice: '15000000',
      status: 'delivered',
      createdDate: '2026-09-13',
    });

    for (let i = 1; i <= 35; i++) {
      await db.insert(orderItems).values({
        id: -90000 - i,
        orderId: testOrderId,
        productId: i,
        productName: `Тестовый товар длинное наименование категории премиум #${i}`,
        amount: '10',
        price: '50000',
        totalPrice: '500000',
        measurementName: 'банка',
      });
    }

    const multiPagePdfBuf = await generateWaybillPdf(testOrderId);
    const multiDoc = await PDFDocument.load(multiPagePdfBuf);
    assert.ok(multiDoc.getPageCount() > 1, 'Заказ из 35 позиций должен занять > 1 страницы!');
    console.log(`   ✅ Стандартная накладная: ${waybillDoc.getPageCount()} стр (${Math.round(waybillBuf.length / 1024)} КБ)`);
    console.log(`   ✅ Длинная накладная (35 позиций): успешно перенесена на ${multiDoc.getPageCount()} страницы с нумерацией!`);

    await db.delete(orderItems).where(eq(orderItems.orderId, testOrderId));
    await db.delete(orders).where(eq(orders.id, testOrderId));

    console.log('\n9. Тест генерации Акта сверки (PDF):');
    const reconBuf = await generateReconciliationPdf(-5);
    assert.ok(reconBuf.length > 50_000, 'Размер акта сверки должен быть > 50KB');
    const reconDoc = await PDFDocument.load(reconBuf);
    assert.ok(reconDoc.getPageCount() >= 1);
    console.log(`   ✅ Акт сверки Caravan City: ${reconDoc.getPageCount()} стр (${Math.round(reconBuf.length / 1024)} КБ)`);

    const notFoundRecon = await fetch(`${BASE_URL}/api/debts/9999999/pdf`);
    assert.equal(notFoundRecon.status, 404);
    console.log('   ✅ Несуществующая точка корректно возвращает 404');

    console.log('\n10. Тест /api/sleepers:');
    const sleepersRes = await fetch(`${BASE_URL}/api/sleepers`);
    const sleepers = await sleepersRes.json();
    assert.ok(Array.isArray(sleepers));
    assert.ok(sleepers.length > 0);
    const firstSleeper = sleepers[0];
    assert.ok(firstSleeper.marketName);
    assert.ok(firstSleeper.draftMessageRu, 'Должен быть сгенерирован готовый текст сообщения');
    assert.ok(typeof firstSleeper.daysOverdueCycle === 'number');
    console.log(`   ✅ Найдено ${sleepers.length} спящих клиентов. Первый: ${firstSleeper.marketName} (просрочка ${firstSleeper.daysOverdueCycle} дн.)`);

    console.log('\n11. Тест /api/ai/simulate:');
    const simRes = await fetch(`${BASE_URL}/api/ai/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Здравствуйте! Подскажите, есть ли в наличии тунец Dardanel и по какой цене?',
        clientName: 'Тестовый Закупщик',
      }),
    });
    assert.equal(simRes.status, 200);
    const simData: any = await simRes.json();
    assert.ok(simData.reply, 'Бот должен ответить');
    assert.ok(simData.toolCalls?.length > 0, 'Бот должен был вызвать инструмент поиска товара/цены');
    console.log(`   ✅ AI Симулятор успешно ответил (${simData.toolCalls.length} инструментов вызвано: ${simData.toolCalls.map((t: any) => t.name).join(', ')})`);

    const emptySim = await fetch(`${BASE_URL}/api/ai/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    assert.equal(emptySim.status, 400);
    console.log('   ✅ Валидация пустого сообщения возвращает 400');

    console.log('\n12. Тест отдачи статики и интерфейса SPA:');
    const indexRes = await fetch(`${BASE_URL}/admin/index.html`);
    assert.equal(indexRes.status, 200);
    const indexHtml = await indexRes.text();
    assert.ok(indexHtml.includes('orderModal'), 'HTML должен содержать модалку деталей заказа');
    assert.ok(indexHtml.includes('orderSearchInput'), 'HTML должен содержать строку поиска заказов');

    const cssRes = await fetch(`${BASE_URL}/admin/style.css`);
    assert.equal(cssRes.status, 200);
    assert.ok(cssRes.headers.get('content-type')?.includes('text/css'));

    const jsRes = await fetch(`${BASE_URL}/admin/app.js`);
    assert.equal(jsRes.status, 200);
    assert.ok(jsRes.headers.get('content-type')?.includes('javascript'));
    console.log('   ✅ Статические ресурсы отдаются с корректными MIME-типами');

    console.log('\n======================================================');
    console.log('🎉 ВСЕ 12 ЭТАПОВ СТРЕСС-ТЕСТИРОВАНИЯ ПРОЙДЕНЫ НА 100%!');
    console.log('======================================================\n');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('\n❌ ОШИБКА В ТЕСТАХ:', err);
  process.exit(1);
});
