import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import {
  syncState, markets, products, prices, balances,
  orders, orderItems, payments, promotions,
} from '../db/schema.js';
import { linko, maxTm } from './client.js';
import { normalizePhone } from '../lib/phone.js';
import { toSum } from '../lib/money.js';
import { log } from '../lib/logger.js';

export type Entity =
  | 'markets' | 'products' | 'prices' | 'balances'
  | 'orders' | 'payments' | 'promotions';

export interface SyncResult {
  entity: Entity;
  rows: number;
  fromTm: number;
  toTm: number;
  ms: number;
  error?: string;
}

async function readCursor(entity: Entity): Promise<number> {
  const db = await getDb();
  const row = await db.select().from(syncState).where(eq(syncState.entity, entity)).limit(1);
  return Number(row[0]?.lastTm ?? 0);
}

async function writeCursor(entity: Entity, tm: number, rows: number, error?: string) {
  const db = await getDb();
  await db.insert(syncState)
    .values({
      entity, lastTm: String(tm), lastRunAt: new Date(),
      rowsTotal: rows, lastError: error ?? null,
    })
    .onConflictDoUpdate({
      target: syncState.entity,
      set: {
        lastTm: String(tm), lastRunAt: new Date(),
        rowsTotal: sql`${syncState.rowsTotal} + ${rows}`,
        lastError: error ?? null,
      },
    });
}

/** Обёртка: замер, курсор, обработка ошибки */
async function run(
  entity: Entity,
  fn: (fromTm: number) => Promise<{ rows: number; toTm: number }>,
): Promise<SyncResult> {
  const started = Date.now();
  const fromTm = await readCursor(entity);
  try {
    const { rows, toTm } = await fn(fromTm);
    await writeCursor(entity, toTm, rows);
    const r: SyncResult = { entity, rows, fromTm, toTm, ms: Date.now() - started };
    if (rows > 0) log.info(`sync ${entity}: +${rows} записей`, { ms: r.ms });
    else log.debug(`sync ${entity}: без изменений`);
    return r;
  } catch (e) {
    const msg = (e as Error).message;
    await writeCursor(entity, fromTm, 0, msg);
    log.error(`sync ${entity} упал`, msg);
    return { entity, rows: 0, fromTm, toTm: fromTm, ms: Date.now() - started, error: msg };
  }
}

/* ─────────── Сущности ─────────── */

export const syncMarkets = () => run('markets', async (fromTm) => {
  const db = await getDb();
  let count = 0, tm = fromTm;

  await linko.markets({ last_tm: fromTm || undefined }, async (rows) => {
    if (!rows.length) return;
    tm = maxTm(rows, tm);
    count += rows.length;

    for (const m of rows) {
      const phones = (m.market_phones ?? [])
        .map((p) => normalizePhone(p.phone))
        .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
        .map((r) => r.e164);

      await db.insert(markets).values({
        id: m.id,
        uuid: m.uuid ?? null,
        serviceId: m.service_id ?? null,
        name: m.name,
        inn: m.inn ?? null,
        code: m.code ?? null,
        contactName: m.contact_name ?? null,
        phones,
        marketTypeId: m.market_type?.id ?? null,
        marketTypeName: m.market_type?.name ?? null,
        responsibleAgentId: m.responsible_agent?.id ?? null,
        priceListId: m.price_list?.id ?? null,
        address: m.address ?? null,
        lat: m.location?.lat != null ? String(m.location.lat) : null,
        lon: m.location?.lon != null ? String(m.location.lon) : null,
        tm: m.tm != null ? String(m.tm) : null,
        raw: m,
      }).onConflictDoUpdate({
        target: markets.id,
        set: {
          name: m.name, inn: m.inn ?? null, code: m.code ?? null,
          contactName: m.contact_name ?? null, phones,
          marketTypeId: m.market_type?.id ?? null,
          marketTypeName: m.market_type?.name ?? null,
          responsibleAgentId: m.responsible_agent?.id ?? null,
          priceListId: m.price_list?.id ?? null,
          address: m.address ?? null,
          tm: m.tm != null ? String(m.tm) : null,
          raw: m,
        },
      });
    }
  });

  return { rows: count, toTm: tm };
});

export const syncProducts = () => run('products', async (fromTm) => {
  const db = await getDb();
  let count = 0, tm = fromTm;

  await linko.products({ last_tm: fromTm || undefined }, async (rows) => {
    if (!rows.length) return;
    tm = maxTm(rows, tm);
    count += rows.length;

    for (const p of rows) {
      const v = {
        id: p.id,
        serviceId: p.service_id ?? null,
        code: p.code ?? null,
        name: p.name,
        productTypeId: p.product_type?.id ?? null,
        measurementName: p.measurement?.name ?? null,
        isActive: p.is_active ?? true,
        tm: p.tm != null ? String(p.tm) : null,
        raw: p,
      };
      await db.insert(products).values(v).onConflictDoUpdate({
        target: products.id,
        set: { name: v.name, code: v.code, productTypeId: v.productTypeId,
               measurementName: v.measurementName, isActive: v.isActive, tm: v.tm, raw: v.raw },
      });
    }
  });

  return { rows: count, toTm: tm };
});

export const syncPrices = () => run('prices', async (fromTm) => {
  const db = await getDb();
  let count = 0, tm = fromTm;

  await linko.priceListItems({ last_tm: fromTm || undefined }, async (rows) => {
    if (!rows.length) return;
    tm = maxTm(rows, tm);

    for (const it of rows) {
      const plId = it.price_list?.id, prId = it.product?.id;
      if (plId == null || prId == null) continue;
      count++;
      await db.insert(prices).values({
        priceListId: plId, productId: prId,
        price: String(toSum(it.price)),
        tm: it.tm != null ? String(it.tm) : null,
      }).onConflictDoUpdate({
        target: [prices.priceListId, prices.productId],
        set: { price: String(toSum(it.price)), tm: it.tm != null ? String(it.tm) : null },
      });
    }
  });

  return { rows: count, toTm: tm };
});

export const syncBalances = () => run('balances', async (fromTm) => {
  const db = await getDb();
  let count = 0, tm = fromTm;

  await linko.productBalances({ last_tm: fromTm || undefined }, async (rows) => {
    if (!rows.length) return;
    tm = maxTm(rows, tm);

    for (const b of rows) {
      const stId = b.stock?.id, prId = b.product?.id;
      if (stId == null || prId == null) continue;
      count++;
      await db.insert(balances).values({
        stockId: stId, productId: prId,
        balance: String(Number(b.balance ?? 0)),
        tm: b.tm != null ? String(b.tm) : null,
      }).onConflictDoUpdate({
        target: [balances.stockId, balances.productId],
        set: { balance: String(Number(b.balance ?? 0)), tm: b.tm != null ? String(b.tm) : null },
      });
    }
  });

  return { rows: count, toTm: tm };
});

export const syncOrders = () => run('orders', async (fromTm) => {
  const db = await getDb();
  let count = 0, tm = fromTm;

  await linko.orders({ last_tm: fromTm || undefined }, async (rows) => {
    if (!rows.length) return;
    tm = maxTm(rows, tm);
    count += rows.length;

    for (const o of rows) {
      const v = {
        id: o.id,
        uuid: o.uuid ?? null,
        serviceId: o.service_id ?? null,
        marketId: o.market?.id ?? null,
        marketName: o.market?.name ?? null,
        marketInn: o.market?.inn ?? null,
        agentId: o.agent?.id ?? null,
        deliveryManId: o.delivery_man?.id ?? null,
        stockId: o.stock?.id ?? null,
        status: o.status ?? null,
        paymentType: o.payment_type ?? null,
        createdDate: o.created_date ?? null,
        dateDelivery: o.date_delivery ?? null,
        paymentDate: o.payment_date ?? null,
        invoiceNumber: o.invoice_number ?? null,
        invoiceDate: o.invoice_date ?? null,
        totalPrice: String(toSum(o.total_price)),
        discountPrice: String(toSum(o.discount_price)),
        comment: o.comment ?? null,
        tm: o.tm != null ? String(o.tm) : null,
        raw: o,
      };

      await db.insert(orders).values(v).onConflictDoUpdate({
        target: orders.id,
        set: {
          status: v.status, paymentType: v.paymentType,
          dateDelivery: v.dateDelivery, paymentDate: v.paymentDate,
          invoiceNumber: v.invoiceNumber, invoiceDate: v.invoiceDate,
          totalPrice: v.totalPrice, discountPrice: v.discountPrice,
          comment: v.comment, tm: v.tm, raw: v.raw,
        },
      });

      // Состав заказа перезаписываем целиком — позиции могли измениться
      if (o.products?.length) {
        await db.delete(orderItems).where(eq(orderItems.orderId, o.id));
        for (const it of o.products) {
          await db.insert(orderItems).values({
            id: it.id,
            orderId: o.id,
            productId: it.product?.id ?? null,
            productName: it.product?.name ?? null,
            amount: String(Number(it.amount ?? 0)),
            price: String(toSum(it.price)),
            totalPrice: String(toSum(it.total_price)),
            totalDiscount: String(toSum(it.total_discount)),
            measurementName: it.measurement?.name ?? null,
          }).onConflictDoNothing();
        }
      }
    }
  });

  return { rows: count, toTm: tm };
});

export const syncPayments = () => run('payments', async (fromTm) => {
  const db = await getDb();
  let count = 0, tm = fromTm;

  await linko.payments({ last_tm: fromTm || undefined }, async (rows) => {
    if (!rows.length) return;
    tm = maxTm(rows, tm);
    count += rows.length;

    for (const p of rows) {
      const v = {
        id: p.id,
        uuid: p.uuid ?? null,
        serviceId: p.service_id ?? null,
        marketId: p.market?.id ?? null,
        marketName: p.market?.name ?? null,
        marketInn: p.market?.inn ?? null,
        orderId: p.order_id ?? null,
        amount: String(toSum(p.amount)),
        paymentType: p.payment_type ?? null,
        status: p.status ?? null,
        type: p.type ?? null,
        userId: p.user?.id ?? null,
        comment: p.comment ?? null,
        createdDate: p.created_date ?? null,
        acceptedTime: p.accepted_time ?? null,
        isDelete: p.is_delete ?? false,
        tm: p.tm != null ? String(p.tm) : null,
        raw: p,
      };
      await db.insert(payments).values(v).onConflictDoUpdate({
        target: payments.id,
        set: {
          amount: v.amount, status: v.status, paymentType: v.paymentType,
          acceptedTime: v.acceptedTime, isDelete: v.isDelete, tm: v.tm, raw: v.raw,
        },
      });
    }
  });

  return { rows: count, toTm: tm };
});

export const syncPromotions = () => run('promotions', async (fromTm) => {
  const db = await getDb();
  let count = 0, tm = fromTm;

  await linko.promotions({ last_tm: fromTm || undefined }, async (rows) => {
    if (!rows.length) return;
    tm = maxTm(rows, tm);
    count += rows.length;

    for (const p of rows) {
      const v = {
        id: p.id, name: p.name,
        type: p.type ?? null,
        discountType: p.discount_type ?? null,
        beginDate: p.begin_date ?? null,
        tillDate: p.till_date ?? null,
        discount: p.discount != null ? String(p.discount) : null,
        isApplyAll: p.is_apply_all ?? false,
        products: p.products ?? null,
        tm: p.tm != null ? String(p.tm) : null,
        raw: p,
      };
      await db.insert(promotions).values(v).onConflictDoUpdate({
        target: promotions.id,
        set: { name: v.name, type: v.type, discountType: v.discountType,
               beginDate: v.beginDate, tillDate: v.tillDate, discount: v.discount,
               isApplyAll: v.isApplyAll, products: v.products, tm: v.tm, raw: v.raw },
      });
    }
  });

  return { rows: count, toTm: tm };
});

/** Полный проход. Порядок важен: справочники раньше документов. */
export async function syncAll(): Promise<SyncResult[]> {
  return [
    await syncMarkets(),
    await syncProducts(),
    await syncPrices(),
    await syncBalances(),
    await syncPromotions(),
    await syncOrders(),
    await syncPayments(),
  ];
}
