/**
 * Демо-данные, чтобы проверить Telegram-часть, пока Linko закрыт.
 *
 *   npm run seed
 *
 * Кладёт в базу несколько точек, заказов и перечислений — ровно той формы,
 * что отдаёт Linko. Карточки ЭСФ после этого можно смотреть командой /esf.
 * Реальную синхронизацию не трогает: у демо-записей отрицательные id.
 */
import { migrate } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import {
  markets, orders, orderItems, payments, esfQueue, outbox,
  products, prices, balances, promotions,
} from '../db/schema.js';
import { inArray, lt } from 'drizzle-orm';
import { todayTashkent } from '../lib/money.js';

// Всё выдумано: id отрицательные, ИНН и телефоны заведомо нерабочие.
// Реальные данные клиентов в репозиторий попадать не должны.
const DEMO_MARKETS = [
  { id: -1, name: 'MARKET 1 · Чиланзар', inn: '100000001', phone: '+998900000001' },
  { id: -2, name: 'Магазин «Барака»', inn: '100000002', phone: '+998900000002' },
  { id: -3, name: 'ООО «Дилшод Савдо»', inn: '100000003', phone: '+998900000003' },
  { id: -4, name: 'Кафе «Султан»', inn: '100000004', phone: '+998900000004' },
  { id: -5, name: 'Ресторан «Caravan City»', inn: '100000005', phone: '+998900000005' },
];

const DEMO_ITEMS = [
  // Уксусы Sayam (500 мл стекло)
  { id: -1, name: 'Яблочный уксус фильтрованный Sayam 500 мл', price: 29_000, amount: 12, unit: 'бут', stock: 650 },
  { id: -2, name: 'Яблочный уксус нефильтрованный Sayam 500 мл', price: 39_000, amount: 12, unit: 'бут', stock: 420 },
  { id: -3, name: 'Белый виноградный уксус Sayam 500 мл', price: 29_000, amount: 12, unit: 'бут', stock: 380 },
  { id: -4, name: 'Черный виноградный уксус Sayam 500 мл', price: 29_000, amount: 12, unit: 'бут', stock: 310 },
  { id: -5, name: 'Бальзамический уксус Sayam 500 мл', price: 39_000, amount: 12, unit: 'бут', stock: 290 },

  // Burcu: томатная паста, соусы, вяленые томаты, пицца соус
  { id: -6, name: 'Томатная паста Burcu 830 г ж/б', price: 37_000, amount: 12, unit: 'бан', stock: 850 },
  { id: -7, name: 'Томатная паста Burcu 600 г стекло', price: 37_000, amount: 12, unit: 'бан', stock: 540 },
  { id: -8, name: 'Томатная паста Burcu 4300 г ж/б', price: 149_900, amount: 6, unit: 'бан', stock: 210 },
  { id: -9, name: 'Соус Napolitena Burcu 310 г стекло', price: 20_000, amount: 12, unit: 'бан', stock: 400 },
  { id: -10, name: 'Соус Arrabbiata Burcu 310 г стекло', price: 20_000, amount: 12, unit: 'бан', stock: 380 },
  { id: -11, name: 'Вяленые помидоры в масле Burcu 300 г стекло', price: 39_000, amount: 12, unit: 'бан', stock: 290 },
  { id: -12, name: 'Пицца соус Burcu 580 г стекло', price: 26_000, amount: 12, unit: 'бан', stock: 720 },
  { id: -13, name: 'Пицца соус Burcu 4200 г ж/б', price: 139_900, amount: 6, unit: 'бан', stock: 180 },

  // Соусы и соки Doganay & Nare
  { id: -14, name: 'Гранатовый соус Doganay 340 г ПЭТ', price: 25_900, amount: 12, unit: 'бут', stock: 510 },
  { id: -15, name: 'Гранатовый соус Doganay 680 г ПЭТ', price: 34_900, amount: 12, unit: 'бут', stock: 320 },
  { id: -16, name: 'Гранатовый соус Doganay 1000 г ПЭТ', price: 42_900, amount: 12, unit: 'бут', stock: 280 },
  { id: -17, name: 'Лимонный соус Doganay 500 мл ПЭТ', price: 19_900, amount: 12, unit: 'бут', stock: 600 },
  { id: -18, name: '100% Лимонный сок Doganay 500 мл ПЭТ', price: 26_000, amount: 12, unit: 'бут', stock: 430 },
  { id: -19, name: '100% Гранатовый соус Nare 340 г стекло', price: 37_000, amount: 6, unit: 'бут', stock: 250 },
  { id: -20, name: 'Виноградный уксус Nare 500 мл ПЭТ', price: 20_000, amount: 12, unit: 'бут', stock: 340 },

  // Тунец Dardanel
  { id: -21, name: 'Тунец кусочками в собственном соку Dardanel 150 г', price: 29_900, amount: 24, unit: 'бан', stock: 1400 },
  { id: -22, name: 'Тунец кусковой в подсолнечном масле Dardanel 150 г', price: 27_900, amount: 24, unit: 'бан', stock: 1600 },
  { id: -23, name: 'Тунец филе в подсолнечном масле Dardanel 150 г', price: 29_900, amount: 24, unit: 'бан', stock: 1200 },
  { id: -24, name: 'Тунец кусковой в оливковом масле Dardanel 150 г', price: 34_900, amount: 24, unit: 'бан', stock: 800 },
  { id: -25, name: 'Тунец в подсолнечном масле Dardanel HoReCa 1705 г', price: 245_000, amount: 6, unit: 'бан', stock: 260 },

  // Халапеньо & Чили
  { id: -26, name: 'Халапеньо Kavaklidere Efor 650 г стекло', price: 44_000, amount: 12, unit: 'бан', stock: 350 },
  { id: -27, name: 'Халапеньо Kavaklidere Efor 325 г стекло', price: 23_500, amount: 12, unit: 'бан', stock: 410 },
  { id: -28, name: 'Сладкий соус чили для курицы Scoville 5600 г', price: 180_000, amount: 1, unit: 'кан', stock: 95 },
];

const DEMO_PROMOS = [
  { id: -31, name: 'Скидка 10% на тунец Dardanel от 5 коробок', discount: 10, days: 21 },
  { id: -32, name: 'При заказе от 3 банок пицца соуса Burcu 4200 г — доставка бесплатно', discount: null, days: 10 },
];

function daysBack(n: number): string {
  return new Date(Date.now() + 5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  await migrate();
  const db = await getDb();

  // Чистим прошлый прогон, чтобы демо можно было пересоздавать
  await db.delete(orderItems).where(lt(orderItems.orderId, 0));
  await db.delete(esfQueue).where(lt(esfQueue.orderId, 0));
  await db.delete(orders).where(lt(orders.id, 0));
  await db.delete(payments).where(lt(payments.id, 0));
  await db.delete(markets).where(lt(markets.id, 0));
  await db.delete(prices).where(lt(prices.productId, 0));
  await db.delete(balances).where(lt(balances.productId, 0));
  await db.delete(products).where(lt(products.id, 0));
  await db.delete(promotions).where(lt(promotions.id, 0));
  await db.delete(outbox).where(inArray(outbox.kind, ['esf_card', 'payment_card', 'esf_items']));

  for (const m of DEMO_MARKETS) {
    await db.insert(markets).values({
      id: m.id, name: m.name, inn: m.inn,
      phones: [m.phone], priceListId: 1, tm: '0',
    });
  }

  // Товары, цены по прайсу 1 и остатки — без них агенту нечего искать
  for (const it of DEMO_ITEMS) {
    await db.insert(products).values({
      id: it.id, name: it.name, measurementName: it.unit,
      isActive: true, tm: '0',
    });
    await db.insert(prices).values({
      priceListId: 1, productId: it.id, price: String(it.price), tm: '0',
    });
    await db.insert(balances).values({
      stockId: 1, productId: it.id, balance: String(it.stock), tm: '0',
    });
  }

  for (const p of DEMO_PROMOS) {
    await db.insert(promotions).values({
      id: p.id, name: p.name,
      type: 'discount',
      discountType: p.discount ? 'percent' : 'manual',
      beginDate: daysBack(3),
      tillDate: daysBack(-p.days),
      discount: p.discount != null ? String(p.discount) : null,
      isApplyAll: false, tm: '0',
    });
  }

  let itemId = -1;
  const plan = [
    { id: -101, market: DEMO_MARKETS[0]!, status: 'delivered', pay: 'bank', ago: 1, items: [0, 5, 20] },
    { id: -102, market: DEMO_MARKETS[1]!, status: 'delivered', pay: 'cash', ago: 2, items: [6, 11, 21] },
    { id: -103, market: DEMO_MARKETS[2]!, status: 'given', pay: 'bank', ago: 3, items: [1, 7, 22] },
    { id: -104, market: DEMO_MARKETS[0]!, status: 'not_delivered', pay: 'bank', ago: 0, items: [12] },
    // Должник с просрочкой 20 дней (Кафе Султан)
    { id: -105, market: DEMO_MARKETS[3]!, status: 'delivered', pay: 'bank', ago: 25, items: [5, 20] },
    // Спящий клиент (Caravan City): заказывал каждые 7 дней, молчит уже 21 день
    { id: -106, market: DEMO_MARKETS[4]!, status: 'delivered', pay: 'bank', ago: 35, items: [0, 20] },
    { id: -107, market: DEMO_MARKETS[4]!, status: 'delivered', pay: 'bank', ago: 28, items: [0, 20] },
    { id: -108, market: DEMO_MARKETS[4]!, status: 'delivered', pay: 'bank', ago: 21, items: [0, 20] },
  ];

  for (const o of plan) {
    const picked = o.items.map((i) => DEMO_ITEMS[i]!);
    const total = picked.reduce((s, it) => s + it.price * it.amount, 0);
    const discount = o.pay === 'bank' ? Math.round(total * 0.02) : 0;

    await db.insert(orders).values({
      id: o.id,
      uuid: `demo-${Math.abs(o.id)}`,
      marketId: o.market.id,
      marketName: o.market.name,
      marketInn: o.market.inn,
      status: o.status,
      paymentType: o.pay,
      createdDate: daysBack(o.ago),
      dateDelivery: daysBack(Math.max(0, o.ago - 1)),
      paymentDate: o.pay === 'bank' ? daysBack(o.ago - 14) : null,
      totalPrice: String(total - discount),
      discountPrice: String(discount),
      comment: o.id === -102 ? 'Просили доставить до обеда' : null,
      tm: '0',
    });

    for (const it of picked) {
      await db.insert(orderItems).values({
        id: itemId--,
        orderId: o.id,
        productId: it.id,
        productName: it.name,
        amount: String(it.amount),
        price: String(it.price),
        totalPrice: String(it.price * it.amount),
        totalDiscount: '0',
        measurementName: it.unit,
      });
    }
  }

  await db.insert(payments).values([
    {
      id: -201, uuid: 'demo-pay-1',
      marketId: -1, marketName: DEMO_MARKETS[0]!.name, marketInn: DEMO_MARKETS[0]!.inn,
      orderId: -101, amount: '5000000', paymentType: 'bank', status: 'accepted',
      createdDate: daysBack(1), comment: 'Оплата по заказу №-101', tm: '0',
    },
    {
      id: -202, uuid: 'demo-pay-2',
      marketId: -3, marketName: DEMO_MARKETS[2]!.name, marketInn: DEMO_MARKETS[2]!.inn,
      amount: '12400000', paymentType: 'bank', status: 'accepted',
      createdDate: daysBack(2), comment: 'Частичное погашение', tm: '0',
    },
    {
      id: -203, uuid: 'demo-pay-3',
      marketId: -5, marketName: DEMO_MARKETS[4]!.name, marketInn: DEMO_MARKETS[4]!.inn,
      amount: '5000000', paymentType: 'bank', status: 'accepted',
      createdDate: daysBack(20), comment: 'Полная оплата всех заказов Caravan City', tm: '0',
    },
  ]);

  console.log(`\n  Демо-данные готовы (${todayTashkent()}):`);
  console.log(`    точек: ${DEMO_MARKETS.length}`);
  console.log(`    товаров: ${DEMO_ITEMS.length} (официальный ассортимент Прайс 2026.pdf)`);
  console.log(`    акций: ${DEMO_PROMOS.length}`);
  console.log(`    заказов: ${plan.length} — из них к ЭСФ подлежат 3`);
  console.log(`    перечислений: 2`);
  console.log(`\n  Дальше: npm run dev, затем в группе бухгалтеров команда /esf\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Не удалось создать демо-данные:', (e as Error).message);
  process.exit(1);
});
