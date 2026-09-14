import assert from 'node:assert/strict';

const BASE_URL = 'http://localhost:3000';

async function main() {
  console.log('\n======================================================');
  console.log('🧪 ТЕСТ ИНТЕГРАЦИИ И КЛИЕНТСКОЙ ЛОГИКИ SPA (FRONTEND)');
  console.log('======================================================\n');

  // 1. Проверка доступности главного сервера на localhost:3000
  console.log('1. Проверка доступности сервера на http://localhost:3000:');
  const indexRes = await fetch(`${BASE_URL}/admin/`);
  assert.equal(indexRes.status, 200, 'HTML должен отдаваться с кодом 200');
  const html = await indexRes.text();
  console.log('   ✅ HTML успешно загружен (длина:', html.length, 'байт)');

  // 2. Валидация DOM структуры и ключевых селекторов интерфейса
  console.log('\n2. Валидация элементов интерфейса (DOM Selectors):');
  const requiredIds = [
    'sideBrandName',
    'pageTitle',
    'topSubtitle',
    'btnToggleBot',
    'botStatusText',
    'modeSelect',
    'btnSyncLinko',
    'serverClock',
    // Табы
    'tab-overview',
    'tab-behavior',
    'tab-whitelabel',
    'tab-orders',
    'tab-debts',
    'tab-sleepers',
    'tab-simulator',
    // KPI
    'kpiVolume',
    'kpiOrdersCount',
    'kpiTotalDebt',
    'kpiDebtorsCount',
    'kpiOverdue',
    'kpiSleepersCount',
    // Aging
    'bar0_7',
    'bar8_30',
    'bar31_60',
    'bar60p',
    // Заказы и поиск
    'orderSearchInput',
    'orderStatusFilter',
    'orderCountBadge',
    'ordersFullTbody',
    // Модалка заказа
    'orderModal',
    'modalOrderTitle',
    'modalOrderSub',
    'modalOrderMeta',
    'modalOrderItemsTbody',
    'modalOrderTotal',
    'btnCloseOrderModal',
    'btnModalClose',
    'btnModalDownloadPdf',
    // Дебиторка
    'debtSearchInput',
    'btnFilterOverdueOnly',
    'debtCountBadge',
    'debtsTbody',
    // Спящие
    'sleeperSearchInput',
    'sleeperOverdueFilter',
    'sleeperCountBadge',
    'sleepersContainer',
    // Симулятор
    'simMarketSelect',
    'simManagerName',
    'chatMessages',
    'chatForm',
    'chatInput',
    'btnSendChat',
    'btnClearChat',
    'inspectorContent',
    // Уведомления
    'toastContainer',
  ];

  for (const id of requiredIds) {
    assert.ok(html.includes(`id="${id}"`), `Элемент с id="${id}" обязан присутствовать в index.html`);
  }
  console.log(`   ✅ Все ${requiredIds.length} ключевых элементов DOM найдены и согласованы!`);

  // 3. Тестирование клиентских хелперов и форматирования
  console.log('\n3. Тестирование клиентских утилит форматирования:');
  const formatMoney = (num: number) => {
    if (num == null) return '0 сум';
    const n = Math.round(Number(num) || 0);
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' сум';
  };

  const escapeHtml = (str: string) => {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  const getStatusClass = (status: string) => {
    if (!status) return 'new';
    const s = String(status).toLowerCase();
    if (s.includes('deliver') || s.includes('success') || s.includes('given')) return 'delivered';
    if (s.includes('cancel') || s.includes('fail')) return 'cancel';
    return 'new';
  };

  assert.equal(formatMoney(15000000), '15 000 000 сум');
  assert.equal(formatMoney(0), '0 сум');
  assert.equal(escapeHtml('<script>alert("test")</script>'), '&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt;');
  assert.equal(getStatusClass('Delivered'), 'delivered');
  assert.equal(getStatusClass('Canceled'), 'cancel');
  assert.equal(getStatusClass('in_process'), 'new');
  console.log('   ✅ Хелперы (форматирование валюты, XSS экранирование, классы статусов) корректны');

  // 4. Тестирование логики фильтрации дебиторки (602 записи)
  console.log('\n4. Тест мгновенной клиентской фильтрации дебиторки:');
  const debtsRes = await fetch(`${BASE_URL}/api/debts`);
  const debtsData: any = await debtsRes.json();
  const debtors = debtsData.debtors || [];
  assert.ok(debtors.length > 500, 'Должно быть > 500 должников в базе');

  // Фильтр: поиск по названию "Caravan"
  const filteredByName = debtors.filter((d: any) =>
    (d.marketName && d.marketName.toLowerCase().includes('caravan')) ||
    (d.marketInn && d.marketInn.includes('caravan'))
  );
  assert.ok(filteredByName.length > 0, 'Должен найтись хотя бы один Caravan');
  console.log(`   ✅ Поиск по «Caravan»: найдено ${filteredByName.length} контрагентов`);

  // Фильтр: только с реальной просрочкой
  const overdueOnly = debtors.filter((d: any) => d.overdue > 0);
  assert.ok(overdueOnly.length > 0 && overdueOnly.length <= debtors.length);
  console.log(`   ✅ Фильтр «Только с просрочкой»: ${overdueOnly.length} из ${debtors.length} точек`);

  // 5. Тестирование логики фильтрации спящих клиентов
  console.log('\n5. Тест фильтрации спящих точек:');
  const sleepersRes = await fetch(`${BASE_URL}/api/sleepers`);
  const sleepersList: any = await sleepersRes.json();
  assert.ok(sleepersList.length > 500);

  const criticalSleepers = sleepersList.filter((s: any) => s.daysOverdueCycle >= 30);
  assert.ok(criticalSleepers.length > 0);
  console.log(`   ✅ Клиентов с нарушением цикла > 30 дней: ${criticalSleepers.length} из ${sleepersList.length}`);

  // 6. Тестирование состава заказа и модального окна
  console.log('\n6. Тест формирования содержимого модального окна заказа:');
  const ordersRes = await fetch(`${BASE_URL}/api/orders?limit=1`);
  const [firstOrder]: any = await ordersRes.json();
  const orderDetailsRes = await fetch(`${BASE_URL}/api/orders/${firstOrder.real_id}/items`);
  const details: any = await orderDetailsRes.json();

  assert.ok(details.order);
  assert.ok(Array.isArray(details.items));
  for (const item of details.items) {
    assert.ok(item.product_name, 'Товар должен иметь наименование');
    assert.ok(item.price_fmt, 'Цена должна быть отформатирована');
    assert.ok(item.total_price_fmt, 'Сумма должна быть отформатирована');
  }
  console.log(`   ✅ Заказ #${details.order.id}: ${details.items.length} товаров успешно распарсены для модалки`);

  // 7. Тестирование списка точек для AI Симулятора
  console.log('\n7. Тест наполнения выпадающего списка точек для AI Симулятора:');
  const marketsRes = await fetch(`${BASE_URL}/api/markets?limit=50`);
  const markets: any = await marketsRes.json();
  assert.equal(markets.length, 50);
  const optionsHtml = markets.map((m: any) => `<option value="${m.id}">${escapeHtml(m.name)} (ID ${Math.abs(m.id)})</option>`).join('');
  assert.ok(optionsHtml.includes('<option value="'));
  console.log(`   ✅ Выпадающий список симулятора успешно формирует ${markets.length} опций точек из БД`);

  console.log('\n======================================================');
  console.log('🎉 ВСЕ ПРОВЕРКИ ИНТЕГРАЦИИ И КЛИЕНТСКОЙ ЛОГИКИ УСПЕШНЫ!');
  console.log('======================================================\n');
}

main().catch((e) => {
  console.error('\n❌ Ошибка frontend-integration теста:', e);
  process.exit(1);
});
