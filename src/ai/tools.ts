import { and, or, eq, sql, desc } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { products, prices, balances, orders, orderItems, markets, promotions, mediaFiles } from '../db/schema.js';
import { fmtSum, fmtAmount, fmtDate, todayTashkent } from '../lib/money.js';

/**
 * Инструменты агента.
 *
 * Правило: модель ничего не знает про товары, цены и остатки — она их
 * запрашивает здесь. Всё, чего нет в этом списке, она отвечать не должна.
 * Любая арифметика — тоже здесь, а не в голове у модели.
 */

export interface ToolContext {
  /** Точка клиента в Linko. null — клиент ещё не опознан */
  marketId: number | null;
}

export interface ToolResult {
  ok: boolean;
  /** Текст для модели. Короткий и фактический. */
  data: string;
  /** Признак, что нужен человек */
  handoff?: string;
  /** Ключ файла, который надо приложить к ответу */
  sendFile?: string;
}

/** Файл из библиотеки — что модель может предложить клиенту */
export interface MediaOption {
  key: string;
  kind: string;
  title: string;
  description: string | null;
  keywords: string[];
}

/** Активные файлы. Список подмешивается в промпт, чтобы модель знала, что есть. */
export async function listMedia(): Promise<MediaOption[]> {
  const db = await getDb();
  const rows = await db.select().from(mediaFiles).where(eq(mediaFiles.isActive, true));
  return rows.map((r) => ({
    key: r.key, kind: r.kind, title: r.title,
    description: r.description, keywords: r.keywords ?? [],
  }));
}

/** Описания для модели — формат Gemini function declarations */
export const TOOL_DECLARATIONS = [
  {
    name: 'najti_tovar',
    description: 'Найти товар в ассортименте по названию или части названия. Возвращает id, название и единицу измерения.',
    parameters: {
      type: 'OBJECT',
      properties: {
        zapros: { type: 'STRING', description: 'Название или часть названия товара' },
      },
      required: ['zapros'],
    },
  },
  {
    name: 'cena_tovara',
    description: 'Узнать цену товара для точки клиента. Использовать ТОЛЬКО этот инструмент для цен — никогда не называть цену по памяти.',
    parameters: {
      type: 'OBJECT',
      properties: {
        product_id: { type: 'INTEGER', description: 'id товара из najti_tovar' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'ostatok',
    description: 'Проверить наличие товара на складах. Возвращает остаток.',
    parameters: {
      type: 'OBJECT',
      properties: {
        product_id: { type: 'INTEGER', description: 'id товара из najti_tovar' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'moi_zakazy',
    description: 'Последние заказы клиента: номер, дата, сумма, статус, состав.',
    parameters: {
      type: 'OBJECT',
      properties: {
        skolko: { type: 'INTEGER', description: 'Сколько последних заказов вернуть, по умолчанию 3' },
      },
    },
  },
  {
    name: 'status_zakaza',
    description: 'Статус конкретного заказа по его номеру.',
    parameters: {
      type: 'OBJECT',
      properties: {
        order_id: { type: 'INTEGER', description: 'Номер заказа' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'dejstvuyushchie_akcii',
    description: 'Список акций, действующих сегодня. Придумывать акции запрещено — только из этого инструмента.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'otpravit_fayl',
    description: 'Отправить клиенту готовый файл из библиотеки: прайс-лист, фото товара, ролик, реквизиты. Использовать, когда клиент просит прислать что-то из этого списка. Ключи доступных файлов перечислены в контексте — придумывать свои нельзя.',
    parameters: {
      type: 'OBJECT',
      properties: {
        klyuch: { type: 'STRING', description: 'Ключ файла из списка доступных' },
      },
      required: ['klyuch'],
    },
  },
  {
    name: 'pozvat_menedzhera',
    description: 'Передать разговор живому менеджеру. Вызывать при жалобе, при разговоре о долгах и деньгах, по просьбе клиента, или если два раза подряд не удалось понять вопрос.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prichina: { type: 'STRING', description: 'Коротко: почему нужен человек' },
      },
      required: ['prichina'],
    },
  },
] as const;

/* ─────────── Реализации ─────────── */

/**
 * Каталог в Linko ведётся по-русски, а клиенты пишут и на узбекском.
 * Без этого словаря на «guruch» не находится «Рис».
 */
const UZ_RU: Record<string, string> = {
  "yog'": 'масло', yog: 'масло', moy: 'масло', ёғ: 'масло',
  guruch: 'рис', гуруч: 'рис',
  shakar: 'сахар', shakarcha: 'сахар', шакар: 'сахар', qand: 'сахар', қанд: 'сахар',
  un: 'мука', ун: 'мука',
  makaron: 'макароны', макарон: 'макароны',
  tuz: 'соль', туз: 'соль',
  choy: 'чай', чой: 'чай',
  sut: 'молоко', сут: 'молоко',
  tuxum: 'яйцо', тухум: 'яйцо',
  "go'sht": 'мясо', 'go‘sht': 'мясо', gosht: 'мясо', гўшт: 'мясо',
  non: 'хлеб', нон: 'хлеб',
  suv: 'вода', сув: 'вода',
};

/** Варианты запроса: как написали + перевод с узбекского */
function searchVariants(q: string): string[] {
  const low = q.toLowerCase().trim();
  const out = new Set<string>([low]);
  for (const word of low.split(/[\s,]+/)) {
    const ru = UZ_RU[word];
    if (ru) out.add(ru);
  }
  return [...out];
}

async function najtiTovar(args: { zapros?: string }): Promise<ToolResult> {
  const q = String(args.zapros ?? '').trim();
  if (q.length < 2) return { ok: false, data: 'Слишком короткий запрос.' };

  const db = await getDb();
  const variants = searchVariants(q);

  const rows = await db.select().from(products)
    .where(and(
      eq(products.isActive, true),
      or(...variants.map((v) => sql`lower(${products.name}) like ${'%' + v + '%'}`)),
    ))
    .limit(8);

  if (!rows.length) return { ok: true, data: `Товар «${q}» не найден в ассортименте.` };

  return {
    ok: true,
    data: rows.map((p) =>
      `id=${p.id} | ${p.name}${p.measurementName ? ` | ед: ${p.measurementName}` : ''}`,
    ).join('\n'),
  };
}

async function cenaTovara(args: { product_id?: number }, ctx: ToolContext): Promise<ToolResult> {
  const pid = Number(args.product_id);
  if (!Number.isFinite(pid)) return { ok: false, data: 'Не указан товар.' };

  const db = await getDb();
  const [p] = await db.select().from(products).where(eq(products.id, pid)).limit(1);
  if (!p) return { ok: true, data: 'Такого товара нет.' };

  if (ctx.marketId == null) {
    return { ok: false, data: 'Клиент не опознан — точка неизвестна, цену назвать нельзя. Нужен менеджер.' };
  }

  const [m] = await db.select().from(markets).where(eq(markets.id, ctx.marketId)).limit(1);
  if (!m?.priceListId) {
    return { ok: false, data: 'У точки не задан прайс-лист. Цену назвать нельзя, нужен менеджер.' };
  }

  const [row] = await db.select().from(prices)
    .where(and(eq(prices.priceListId, m.priceListId), eq(prices.productId, pid)))
    .limit(1);

  if (!row) {
    return { ok: false, data: `Цена на «${p.name}» для этой точки не найдена. Нужен менеджер.` };
  }

  return { ok: true, data: `${p.name}: ${fmtSum(row.price)}${p.measurementName ? ` за ${p.measurementName}` : ''}` };
}

async function ostatok(args: { product_id?: number }): Promise<ToolResult> {
  const pid = Number(args.product_id);
  if (!Number.isFinite(pid)) return { ok: false, data: 'Не указан товар.' };

  const db = await getDb();
  const [p] = await db.select().from(products).where(eq(products.id, pid)).limit(1);
  if (!p) return { ok: true, data: 'Такого товара нет.' };

  const [agg] = await db
    .select({ total: sql<string>`coalesce(sum(${balances.balance}), 0)` })
    .from(balances).where(eq(balances.productId, pid));

  const total = Number(agg?.total ?? 0);
  return {
    ok: true,
    data: total > 0
      ? `${p.name}: в наличии ${fmtAmount(total)}${p.measurementName ? ` ${p.measurementName}` : ''}`
      : `${p.name}: нет в наличии`,
  };
}

async function moiZakazy(args: { skolko?: number }, ctx: ToolContext): Promise<ToolResult> {
  if (ctx.marketId == null) return { ok: false, data: 'Клиент не опознан — истории заказов нет.' };

  const limit = Math.min(Math.max(Number(args.skolko ?? 3), 1), 5);
  const db = await getDb();

  const rows = await db.select().from(orders)
    .where(eq(orders.marketId, ctx.marketId))
    .orderBy(desc(orders.createdDate), desc(orders.id))
    .limit(limit);

  if (!rows.length) return { ok: true, data: 'Заказов пока не было.' };

  const out: string[] = [];
  for (const o of rows) {
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, o.id));
    const composition = items
      .map((i) => `${i.productName} — ${fmtAmount(i.amount)}${i.measurementName ? ' ' + i.measurementName : ''}`)
      .join('; ');
    out.push(
      `Заказ №${o.id} от ${fmtDate(o.createdDate)}, ${fmtSum(o.totalPrice)}, статус: ${STATUS_RU[o.status ?? ''] ?? o.status}`
      + (composition ? `\n  состав: ${composition}` : ''),
    );
  }
  return { ok: true, data: out.join('\n') };
}

const STATUS_RU: Record<string, string> = {
  not_delivered: 'не доставлен',
  delivered: 'доставлен',
  given: 'выдан',
  cancelled: 'отменён',
};

async function statusZakaza(args: { order_id?: number }, ctx: ToolContext): Promise<ToolResult> {
  const id = Number(args.order_id);
  if (!Number.isFinite(id)) return { ok: false, data: 'Не указан номер заказа.' };

  const db = await getDb();
  const [o] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!o) return { ok: true, data: `Заказа №${id} не найдено.` };

  // Чужой заказ показывать нельзя
  if (ctx.marketId != null && o.marketId !== ctx.marketId) {
    return { ok: false, data: 'Этот заказ относится к другой точке. Нужен менеджер.' };
  }

  return {
    ok: true,
    data: `Заказ №${o.id}: ${STATUS_RU[o.status ?? ''] ?? o.status}, сумма ${fmtSum(o.totalPrice)}`
      + (o.dateDelivery ? `, доставка ${fmtDate(o.dateDelivery)}` : ''),
  };
}

async function dejstvuyushchieAkcii(): Promise<ToolResult> {
  const db = await getDb();
  const today = todayTashkent();

  const rows = await db.select().from(promotions)
    .where(and(
      sql`(${promotions.beginDate} is null or ${promotions.beginDate} <= ${today})`,
      sql`(${promotions.tillDate} is null or ${promotions.tillDate} >= ${today})`,
    ))
    .limit(10);

  if (!rows.length) return { ok: true, data: 'Действующих акций сейчас нет.' };

  return {
    ok: true,
    data: rows.map((p) =>
      `${p.name}${p.discount ? ` — ${p.discount}${p.discountType === 'percent' ? '%' : ''}` : ''}`
      + (p.tillDate ? ` (до ${fmtDate(p.tillDate)})` : ''),
    ).join('\n'),
  };
}

async function otpravitFayl(args: { klyuch?: string }): Promise<ToolResult> {
  const key = String(args.klyuch ?? '').trim();
  if (!key) return { ok: false, data: 'Не указан ключ файла.' };

  const db = await getDb();
  const [f] = await db.select().from(mediaFiles).where(eq(mediaFiles.key, key)).limit(1);

  if (!f || !f.isActive) {
    const avail = await listMedia();
    return {
      ok: false,
      data: avail.length
        ? `Файла «${key}» нет. Доступны: ${avail.map((a) => a.key).join(', ')}`
        : 'Библиотека файлов пуста — отправлять нечего.',
    };
  }

  return {
    ok: true,
    data: `Файл «${f.title}» будет приложен к твоему ответу. Коротко скажи клиенту, что отправляешь — сам файл дублировать текстом не нужно.`,
    sendFile: f.key,
  };
}

async function pozvatMenedzhera(args: { prichina?: string }): Promise<ToolResult> {
  const reason = String(args.prichina ?? 'клиент попросил').slice(0, 200);
  return {
    ok: true,
    data: 'Менеджер уведомлён. Скажи клиенту, что человек скоро подключится, и больше ничего не обещай.',
    handoff: reason,
  };
}

/* ─────────── Диспетчер ─────────── */

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

const HANDLERS: Record<string, Handler> = {
  najti_tovar: (a) => najtiTovar(a as { zapros?: string }),
  cena_tovara: (a, c) => cenaTovara(a as { product_id?: number }, c),
  ostatok: (a) => ostatok(a as { product_id?: number }),
  moi_zakazy: (a, c) => moiZakazy(a as { skolko?: number }, c),
  status_zakaza: (a, c) => statusZakaza(a as { order_id?: number }, c),
  dejstvuyushchie_akcii: () => dejstvuyushchieAkcii(),
  otpravit_fayl: (a) => otpravitFayl(a as { klyuch?: string }),
  pozvat_menedzhera: (a) => pozvatMenedzhera(a as { prichina?: string }),
};

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const h = HANDLERS[name];
  if (!h) return { ok: false, data: `Инструмента «${name}» не существует.` };
  try {
    return await h(args, ctx);
  } catch (e) {
    return { ok: false, data: `Инструмент не отработал: ${(e as Error).message}` };
  }
}
