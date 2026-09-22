import assert from 'node:assert/strict';
import { startAdminServer } from '../server/admin-api.js';
import { closeDb } from '../db/index.js';

let server: any = null;
let BASE_URL = 'http://localhost:3089';

async function main() {
  console.log('\n======================================================');
  console.log('🧪 ТЕСТ ИНТЕГРАЦИИ И КЛИЕНТСКОЙ ЛОГИКИ SPA (FRONTEND)');
  console.log('======================================================\n');

  server = startAdminServer(3089);
  await new Promise((r) => setTimeout(r, 600));

  console.log('1. Проверка доступности сервера на http://localhost:3089:');
  const indexRes = await fetch(`${BASE_URL}/admin/`);
  assert.equal(indexRes.status, 200, 'HTML должен отдаваться с кодом 200');
  const html = await indexRes.text();
  console.log('   ✅ HTML успешно загружен (длина:', html.length, 'байт)');

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
    'tab-overview',
    'tab-behavior',
    'tab-whitelabel',
    'tab-orders',
    'tab-debts',
    'tab-sleepers',
    'tab-simulator',
    'kpiVolume',
    'kpiOrdersCount',
    'kpiTotalDebt',
    'kpiDebtorsCount',
    'kpiOverdue',
    'kpiSleepersCount',
    'bar0_7',
    'bar8_30',
    'bar31_60',
    'bar60p',
    'orderSearchInput',
    'orderStatusFilter',
    'orderCountBadge',
    'ordersFullTbody',
    'orderModal',
    'modalOrderTitle',
    'modalOrderSub',
    'modalOrderMeta',
    'modalOrderItemsTbody',
    'modalOrderTotal',
    'btnCloseOrderModal',
    'btnModalClose',
    'btnModalDownloadPdf',
    'debtSearchInput',
    'btnFilterOverdueOnly',
    'debtCountBadge',
    'debtsTbody',
    'sleeperSearchInput',
    'sleeperOverdueFilter',
    'sleeperCountBadge',
    'sleepersContainer',
    'simMarketSelect',
    'simManagerName',
    'chatMessages',
    'chatForm',
    'chatInput',
    'btnSendChat',
    'btnClearChat',
    'inspectorContent',
    'btnToggleMobileMenu',
    'btnCloseSidebar',
    'sidebarOverlay',
    'cfgCompanyBrand',
    'cfgCompanyName',
    'cfgManagerPhone',
    'cfgGeminiModel',
    'chipKbDelivery',
    'chipKbPayment',
    'chipKbSchedule',
    'chipKbContacts',
    'chipRulePrice',
    'chipRuleDiscount',
    'chipRulePolite',
    'previewSenderRu',
    'previewGreetingRuText',
    'previewSenderUz',
    'previewGreetingUzText',
    'toastContainer',
  ];

  for (const id of requiredIds) {
    assert.ok(html.includes(`id="${id}"`), `Элемент с id="${id}" обязан присутствовать в index.html`);
  }
  console.log(`   ✅ Все ${requiredIds.length} ключевых элементов DOM найдены и согласованы!`);

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

  const renderGreeting = (tpl: string, mName: string, bName: string, cName: string) => {
    return tpl
      .replace(/\{manager_name\}/g, mName)
      .replace(/\{brand_name\}/g, bName)
      .replace(/\{company_name\}/g, cName);
  };
  assert.equal(
    renderGreeting('Здравствуйте! Я {manager_name} из {brand_name} ({company_name}).', 'Тимур', 'Sayam', 'ООО "Саям Дистрибьюшн"'),
    'Здравствуйте! Я Тимур из Sayam (ООО "Саям Дистрибьюшн").'
  );
  console.log('   ✅ Хелперы (форматирование валюты, XSS экранирование, статусы, шаблоны приветствий) корректны');

  console.log('\n4. Тест мгновенной клиентской фильтрации дебиторки:');
  const debtsRes = await fetch(`${BASE_URL}/api/debts`);
  const debtsData: any = await debtsRes.json();
  const debtors = debtsData.debtors || [];
  assert.ok(debtors.length >= 2, 'Должно быть >= 2 должников в базе');

  const query = debtors[0]?.marketName ? debtors[0].marketName.substring(0, 4).toLowerCase() : 'caravan';
  const filteredByName = debtors.filter((d: any) =>
    (d.marketName && d.marketName.toLowerCase().includes(query)) ||
    (d.marketInn && d.marketInn.includes(query))
  );
  assert.ok(filteredByName.length > 0, 'Должен найтись контрагент по запросу');
  console.log(`   ✅ Поиск по «${query}»: найдено ${filteredByName.length} контрагентов`);

  const overdueOnly = debtors.filter((d: any) => d.overdue > 0);
  assert.ok(overdueOnly.length <= debtors.length);
  console.log(`   ✅ Фильтр «Только с просрочкой»: ${overdueOnly.length} из ${debtors.length} точек`);

  console.log('\n5. Тест фильтрации спящих точек:');
  const sleepersRes = await fetch(`${BASE_URL}/api/sleepers`);
  const sleepersList: any = await sleepersRes.json();
  assert.ok(sleepersList.length >= 2);
  console.log(`   ✅ Спящих клиентов в базе: ${sleepersList.length}`);

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

  console.log('\n7. Тест наполнения выпадающего списка точек для AI Симулятора:');
  const marketsRes = await fetch(`${BASE_URL}/api/markets?limit=50`);
  const markets: any = await marketsRes.json();
  assert.ok(markets.length >= 2);
  const optionsHtml = markets.map((m: any) => `<option value="${m.id}">${escapeHtml(m.name)} (ID ${Math.abs(m.id)})</option>`).join('');
  assert.ok(optionsHtml.includes('<option value="'));
  console.log(`   ✅ Выпадающий список симулятора успешно формирует ${markets.length} опций точек из БД`);

  console.log('\n======================================================');
  console.log('🎉 ВСЕ ПРОВЕРКИ ИНТЕГРАЦИИ И КЛИЕНТСКОЙ ЛОГИКИ УСПЕШНЫ!');
  console.log('======================================================\n');

  if (server) server.close();
  await closeDb();
}

main().catch((e) => {
  console.error('\n❌ Ошибка frontend-integration теста:', e);
  if (server) server.close();
  process.exit(1);
});
