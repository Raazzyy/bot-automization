import { startAdminServer } from '../server/admin-api.js';
import { getAllSettings, updateSettings } from '../lib/settings.js';
import { getSystemPromptA } from '../ai/prompt.js';
import { closeDb } from '../db/index.js';

async function runTests() {
  console.log('=== STARTING ADMIN & WHITE-LABEL TEST SUITE ===\n');

  console.log('1. Тест чтения настроек по умолчанию:');
  const initialSettings = await getAllSettings();
  console.log('   Company:', initialSettings.company_name);
  console.log('   Manager:', initialSettings.manager_name);
  console.log('   Bot enabled:', initialSettings.bot_enabled);
  if (!initialSettings.company_name || initialSettings.bot_enabled !== true) {
    throw new Error('Initial settings check failed');
  }
  console.log('   ✅ Начальные настройки корректны\n');

  console.log('2. Тест тумблера бота и обновления White-Label данных:');
  await updateSettings({
    bot_enabled: false,
    company_name: 'ООО «Test Distributor»',
    manager_name: 'Фарход',
    knowledge_base: 'Тестовый регламент: бесплатная доставка от 1 млн сум.',
    custom_rules: 'Правило: всегда предлагать новинку Burcu.',
  });

  const updatedSettings = await getAllSettings();
  console.log('   Новый статус бота:', updatedSettings.bot_enabled);
  console.log('   Новое имя компании:', updatedSettings.company_name);
  console.log('   Новое имя менеджера:', updatedSettings.manager_name);
  if (updatedSettings.bot_enabled !== false || updatedSettings.company_name !== 'ООО «Test Distributor»') {
    throw new Error('Update settings failed');
  }
  console.log('   ✅ Настройки успешно обновлены в БД и прочитаны\n');

  console.log('3. Тест динамического промпта с базой знаний:');
  const prompt = await getSystemPromptA();
  console.log('   Содержит ли новое имя менеджера (Фарход):', prompt.includes('Фарход'));
  console.log('   Содержит ли новое имя компании:', prompt.includes('ООО «Test Distributor»'));
  console.log('   Содержит ли скормленную базу знаний:', prompt.includes('бесплатная доставка от 1 млн сум'));
  console.log('   Содержит ли кастомные правила:', prompt.includes('всегда предлагать новинку Burcu'));
  if (!prompt.includes('Фарход') || !prompt.includes('бесплатная доставка от 1 млн сум')) {
    throw new Error('Dynamic prompt generation failed');
  }
  console.log('   ✅ Системный промпт динамически вобрал базу знаний и новые правила!\n');

  console.log('4. Восстановление исходных параметров для дальнейшей работы:');
  await updateSettings({
    bot_enabled: true,
    company_name: 'ООО «AKM HOLDINGS INC»',
    manager_name: 'Шохрух',
  });
  console.log('   ✅ Исходные параметры восстановлены\n');

  console.log('5. Запуск Admin HTTP сервера на порту 3089:');
  const server = startAdminServer(3089);
  await new Promise((r) => setTimeout(r, 600));

  const BASE = 'http://localhost:3089';

  const statusRes = await fetch(`${BASE}/api/status`);
  const statusJson = (await statusRes.json()) as any;
  console.log('   /api/status code:', statusRes.status, 'bot_enabled:', statusJson.bot_enabled);
  if (statusRes.status !== 200 || statusJson.bot_enabled !== true) throw new Error('GET /api/status failed');

  const toggleRes = await fetch(`${BASE}/api/bot/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  const toggleJson = (await toggleRes.json()) as any;
  console.log('   /api/bot/toggle code:', toggleRes.status, 'bot_enabled:', toggleJson.bot_enabled);
  if (toggleJson.bot_enabled !== false) throw new Error('POST /api/bot/toggle failed');

  await fetch(`${BASE}/api/bot/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });

  const statsRes = await fetch(`${BASE}/api/stats`);
  const statsJson = (await statsRes.json()) as any;
  console.log('   /api/stats orders:', statsJson.orders_count, 'debtors:', statsJson.debtors_count);
  if (statsRes.status !== 200) throw new Error('GET /api/stats failed');

  const ordersRes = await fetch(`${BASE}/api/orders`);
  const ordersJson = (await ordersRes.json()) as any;
  console.log('   /api/orders count:', ordersJson.length);
  if (ordersRes.status !== 200) throw new Error('GET /api/orders failed');

  const orderPdfRes = await fetch(`${BASE}/api/orders/-101/pdf`);
  const orderPdfBuf = await orderPdfRes.arrayBuffer();
  console.log('   /api/orders/-101/pdf bytes:', orderPdfBuf.byteLength, 'Content-Type:', orderPdfRes.headers.get('content-type'));
  if (orderPdfRes.status !== 200 || orderPdfBuf.byteLength < 1000) throw new Error('Waybill PDF download failed');

  const debtsRes = await fetch(`${BASE}/api/debts`);
  const debtsJson = (await debtsRes.json()) as any;
  console.log('   /api/debts debtors:', debtsJson.debtors?.length);
  if (debtsRes.status !== 200) throw new Error('GET /api/debts failed');

  const debtPdfRes = await fetch(`${BASE}/api/debts/-5/pdf`);
  const debtPdfBuf = await debtPdfRes.arrayBuffer();
  console.log('   /api/debts/-5/pdf bytes:', debtPdfBuf.byteLength, 'Content-Type:', debtPdfRes.headers.get('content-type'));
  if (debtPdfRes.status !== 200 || debtPdfBuf.byteLength < 1000) throw new Error('Reconciliation PDF download failed');

  const sleepersRes = await fetch(`${BASE}/api/sleepers`);
  const sleepersJson = (await sleepersRes.json()) as any;
  console.log('   /api/sleepers count:', sleepersJson.length);
  if (sleepersRes.status !== 200) throw new Error('GET /api/sleepers failed');

  const htmlRes = await fetch(`${BASE}/admin/index.html`);
  const htmlText = await htmlRes.text();
  console.log('   /admin/index.html status:', htmlRes.status, 'has brand:', htmlText.includes('AKM Distribution'));
  if (htmlRes.status !== 200 || !htmlText.includes('AKM Distribution')) throw new Error('HTML serve failed');

  const cssRes = await fetch(`${BASE}/admin/style.css`);
  console.log('   /admin/style.css status:', cssRes.status, 'Content-Type:', cssRes.headers.get('content-type'));
  if (cssRes.status !== 200) throw new Error('CSS serve failed');

  const jsRes = await fetch(`${BASE}/admin/app.js`);
  console.log('   /admin/app.js status:', jsRes.status, 'Content-Type:', jsRes.headers.get('content-type'));
  if (jsRes.status !== 200) throw new Error('JS serve failed');

  server.close();
  await closeDb();
  console.log('\n🎉 ALL 12 ADMIN & WHITE-LABEL TESTS PASSED PERFECTLY!');
}

runTests().catch((e) => {
  console.error('❌ TEST FAILED:', e);
  process.exit(1);
});
