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
import { markets, orders, orderItems, payments, esfQueue, outbox } from '../db/schema.js';
import { inArray, lt } from 'drizzle-orm';
import { todayTashkent } from '../lib/money.js';

// Всё выдумано: id отрицательные, ИНН и телефоны заведомо нерабочие.
// Реальные данные клиентов в репозиторий попадать не должны.
const DEMO_MARKETS = [
  { id: -1, name: 'MARKET 1 · Чиланзар', inn: '100000001', phone: '+998900000001' },
  { id: -2, name: 'Магазин «Барака»', inn: '100000002', phone: '+998900000002' },
  { id: -3, name: 'ООО «Дилшод Савдо»', inn: '100000003', phone: '+998900000003' },
];

const DEMO_ITEMS = [
  { name: 'Масло подсолнечное 1 л', price: 24_500, amount: 20, unit: 'шт' },
  { name: 'Сахар-песок 50 кг', price: 610_000, amount: 4, unit: 'меш' },
  { name: 'Мука в/с 50 кг', price: 385_000, amount: 6, unit: 'меш' },
  { name: 'Рис лазер 1 кг', price: 18_900, amount: 40, unit: 'кг' },
  { name: 'Макароны спагетти 450 г', price: 7_400, amount: 60, unit: 'шт' },
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
  await db.delete(outbox).where(inArray(outbox.kind, ['esf_card', 'payment_card', 'esf_items']));

  for (const m of DEMO_MARKETS) {
    await db.insert(markets).values({
      id: m.id, name: m.name, inn: m.inn,
      phones: [m.phone], priceListId: 1, tm: '0',
    });
  }

  let itemId = -1;
  const plan = [
    { id: -101, market: DEMO_MARKETS[0]!, status: 'delivered', pay: 'bank', ago: 1, items: [0, 1, 3] },
    { id: -102, market: DEMO_MARKETS[1]!, status: 'delivered', pay: 'cash', ago: 2, items: [2, 4] },
    { id: -103, market: DEMO_MARKETS[2]!, status: 'given', pay: 'bank', ago: 3, items: [0, 2, 3, 4] },
    { id: -104, market: DEMO_MARKETS[0]!, status: 'not_delivered', pay: 'bank', ago: 0, items: [1] },
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
  ]);

  console.log(`\n  Демо-данные готовы (${todayTashkent()}):`);
  console.log(`    точек: ${DEMO_MARKETS.length}`);
  console.log(`    заказов: ${plan.length} — из них к ЭСФ подлежат 3`);
  console.log(`    перечислений: 2`);
  console.log(`\n  Дальше: npm run dev, затем в группе бухгалтеров команда /esf\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Не удалось создать демо-данные:', (e as Error).message);
  process.exit(1);
});
