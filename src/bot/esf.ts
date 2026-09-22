import type { Api } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import { and, eq, inArray, isNull, sql, desc } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { orders, orderItems, esfQueue, payments } from '../db/schema.js';
import { config } from '../config.js';
import { linko } from '../linko/client.js';
import { send } from './send.js';
import { fmtSum, fmtDate, fmtAmount, fmtNum, todayTashkent } from '../lib/money.js';
import { log } from '../lib/logger.js';
import { generateWaybillPdf } from '../lib/pdf-waybill.js';
import { getCompanyProfile } from '../lib/settings.js';

/** Статусы, при которых заказ подлежит выставлению ЭСФ */
const BILLABLE = ['delivered', 'given'] as const;

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PAYMENT_LABEL: Record<string, string> = {
  cash: 'наличные',
  bank: 'перечисление',
};

/* ─────────── Карточка заказа ─────────── */

export async function buildOrderCard(orderId: number): Promise<string | null> {
  const db = await getDb();
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!o) return null;

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));

  const lines: string[] = [];
  lines.push(`<b>Заказ №${o.id} · к выставлению ЭСФ</b>`);
  lines.push('');
  lines.push(`Точка: <b>${esc(o.marketName ?? '—')}</b>`);
  if (o.marketInn) lines.push(`ИНН: <code>${esc(o.marketInn)}</code>`);
  lines.push(`Дата: ${fmtDate(o.createdDate)}${o.dateDelivery ? ` · доставка ${fmtDate(o.dateDelivery)}` : ''}`);
  lines.push(`Оплата: ${PAYMENT_LABEL[o.paymentType ?? ''] ?? o.paymentType ?? '—'}`);
  if (o.paymentDate) lines.push(`Оплатить до: ${fmtDate(o.paymentDate)}`);
  lines.push(`Позиций: ${items.length}`);

  const discount = Number(o.discountPrice ?? 0);
  if (discount > 0) lines.push(`Скидка: ${fmtSum(discount)}`);
  lines.push(`Сумма: <b>${fmtSum(o.totalPrice)}</b>`);

  if (o.comment) {
    lines.push('');
    lines.push(`<i>${esc(o.comment)}</i>`);
  }

  return lines.join('\n');
}

export async function buildOrderItemsText(orderId: number): Promise<string> {
  const db = await getDb();
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  if (!items.length) return 'Состав заказа не выгружен из Linko.';

  const lines = [`<b>Состав заказа №${orderId}</b>`, ''];
  for (const [i, it] of items.entries()) {
    const unit = it.measurementName ? ` ${esc(it.measurementName)}` : '';
    lines.push(
      `${i + 1}. ${esc(it.productName ?? `товар #${it.productId}`)}`
      + `\n    ${fmtAmount(it.amount)}${unit} × ${fmtNum(it.price)} = <b>${fmtSum(it.totalPrice)}</b>`
      + (Number(it.totalDiscount) > 0 ? `  <i>(−${fmtNum(it.totalDiscount)})</i>` : ''),
    );
  }
  return lines.join('\n');
}

function esfKeyboard(orderId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('ЭСФ выставлен', `esf:issued:${orderId}`)
    .text('Состав', `esf:items:${orderId}`)
    .row()
    .text('📄 Накладная PDF', `esf:pdf:${orderId}`)
    .text('Проблема', `esf:problem:${orderId}`);
}

/* ─────────── Публикация новых заказов ─────────── */

export async function postNewOrders(api: Api): Promise<number> {
  const chat = config.ACCOUNTANT_CHAT_ID;
  if (!chat) {
    log.debug('M1: ACCOUNTANT_CHAT_ID не задан — карточки не публикуются');
    return 0;
  }

  const db = await getDb();
  const today = todayTashkent();

  // Автоматически архивируем все исторические заказы прошлых дней, чтобы они никогда не спамились в Telegram
  try {
    await db.execute(sql`
      INSERT INTO esf_queue (order_id, status)
      SELECT id, 'archived' FROM orders
      WHERE created_date < ${today}
      ON CONFLICT (order_id) DO NOTHING
    `);
  } catch (e) {
    log.warn('Не удалось архивировать исторические заказы', (e as Error).message);
  }

  // Заказы по перечислению, созданные СЕГОДНЯ, подлежащие ЭСФ и ещё не попавшие в очередь
  const fresh = await db
    .select({ id: orders.id })
    .from(orders)
    .leftJoin(esfQueue, eq(esfQueue.orderId, orders.id))
    .where(and(
      eq(orders.paymentType, 'bank'),
      inArray(orders.status, [...BILLABLE]),
      isNull(esfQueue.orderId),
      sql`${orders.createdDate} >= ${today}`,
    ))
    .orderBy(desc(orders.id))
    .limit(20);

  let posted = 0;
  for (const { id } of fresh) {
    const text = await buildOrderCard(id);
    if (!text) continue;

    await db.insert(esfQueue).values({ orderId: id, status: 'new' }).onConflictDoNothing();

    const res = await send(api, {
      dedupeKey: `esf:order:${id}`,
      kind: 'esf_card',
      chatId: chat,
      text,
      audience: 'staff',
      channel: 'B',
      keyboard: esfKeyboard(id),
    });

    await db.update(esfQueue).set({
      status: res.sent ? 'posted' : 'new',
      cardChatId: res.sent ? Number(chat) : null,
      cardMessageId: res.sent ? res.messageId : null,
      postedAt: res.sent ? new Date() : null,
    }).where(eq(esfQueue.orderId, id));

    if (res.sent) posted++;
  }

  if (posted) log.info(`M1: опубликовано карточек — ${posted}`);
  return posted;
}

/* ─────────── Перечисления ─────────── */

export async function postNewPayments(api: Api): Promise<number> {
  const chat = config.ACCOUNTANT_CHAT_ID;
  if (!chat) return 0;

  const db = await getDb();
  const today = todayTashkent();

  // Публикуем перечисления, поступившие СЕГОДНЯ (не поднимаем архивы за 2022-2025)
  const rows = await db.select().from(payments)
    .where(and(
      eq(payments.paymentType, 'bank'),
      eq(payments.status, 'accepted'),
      eq(payments.isDelete, false),
      sql`${payments.createdDate} >= ${today}`,
    ))
    .orderBy(desc(payments.id))
    .limit(20);

  let posted = 0;
  for (const p of rows) {
    const lines = [
      `<b>Перечисление №${p.id}</b>`,
      '',
      `Точка: <b>${esc(p.marketName ?? '—')}</b>`,
      p.marketInn ? `ИНН: <code>${esc(p.marketInn)}</code>` : '',
      `Дата: ${fmtDate(p.createdDate)}`,
      p.orderId ? `По заказу: №${p.orderId}` : '',
      `Сумма: <b>${fmtSum(p.amount)}</b>`,
      p.comment ? `\n<i>${esc(p.comment)}</i>` : '',
    ].filter(Boolean);

    const res = await send(api, {
      dedupeKey: `esf:payment:${p.uuid ?? p.id}`,
      kind: 'payment_card',
      chatId: chat,
      text: lines.join('\n'),
      audience: 'staff',
      channel: 'B',
    });
    if (res.sent) posted++;
  }

  if (posted) log.info(`M1: опубликовано перечислений — ${posted}`);
  return posted;
}

/* ─────────── Кнопки ─────────── */

export async function handleEsfCallback(
  api: Api,
  data: string,
  userId: number,
  userName: string,
): Promise<{ answer: string; alert?: boolean; edit?: string }> {
  const [, action, idRaw] = data.split(':');
  const orderId = Number(idRaw);
  if (!Number.isFinite(orderId)) return { answer: 'Не разобрал заказ' };

  const db = await getDb();

  if (action === 'items') {
    // Состав длинный — во всплывающее окно Telegram (200 символов) не влезет,
    // поэтому отправляем отдельным сообщением в ту же группу.
    await send(api, {
      dedupeKey: `esf:items:${orderId}:${Date.now()}`,
      kind: 'esf_items',
      chatId: config.ACCOUNTANT_CHAT_ID,
      text: await buildOrderItemsText(orderId),
      audience: 'staff',
      channel: 'B',
    });
    return { answer: 'Состав отправлен в чат' };
  }

  if (action === 'pdf') {
    try {
      const pdfBuf = await generateWaybillPdf(orderId);
      const company = await getCompanyProfile();
      const staffChat = config.ACCOUNTANT_CHAT_ID || config.ASSIST_CHAT_ID;
      await api.sendDocument(
        staffChat,
        new InputFile(pdfBuf, `Накладная_№${orderId}.pdf`),
        { caption: `📄 Официальная товарная накладная по заказу №${orderId} (${company.name})` },
      );
      return { answer: 'Накладная PDF отправлена в чат!' };
    } catch (err) {
      log.error(`M1: ошибка генерации PDF для заказа №${orderId}`, err);
      return { answer: `Ошибка: ${(err as Error).message}`, alert: true };
    }
  }

  if (action === 'issued') {
    const [row] = await db.select().from(esfQueue).where(eq(esfQueue.orderId, orderId)).limit(1);
    if (row?.status === 'issued') {
      return { answer: `Уже отмечено: ${row.issuedByName ?? 'кто-то'}`, alert: true };
    }

    await db.update(esfQueue).set({
      status: 'issued',
      issuedAt: new Date(),
      issuedByUserId: userId,
      issuedByName: userName,
    }).where(eq(esfQueue.orderId, orderId));

    // Отмечаем в Linko, что заказ выгружен во внешнюю систему
    let syncNote = '';
    if (config.MODE === 'live') {
      try {
        await linko.markOrdersSynced([orderId]);
        await db.update(esfQueue).set({ syncedToLinko: true }).where(eq(esfQueue.orderId, orderId));
      } catch (e) {
        syncNote = ' (в Linko отметить не удалось)';
        log.error(`M1: order_synced для №${orderId} не прошёл`, (e as Error).message);
      }
    } else {
      syncNote = ` (режим ${config.MODE}: в Linko не отмечаем)`;
    }

    const card = await buildOrderCard(orderId);
    return {
      answer: `Отмечено${syncNote}`,
      edit: card ? `${card}\n\n✅ <b>ЭСФ выставлен</b> — ${esc(userName)}` : undefined,
    };
  }

  if (action === 'problem') {
    await db.update(esfQueue).set({
      status: 'problem',
      note: `отмечено ${userName}`,
    }).where(eq(esfQueue.orderId, orderId));

    const card = await buildOrderCard(orderId);
    return {
      answer: 'Помечено как проблема',
      edit: card ? `${card}\n\n⚠️ <b>Проблема</b> — ${esc(userName)}` : undefined,
    };
  }

  return { answer: 'Неизвестная кнопка' };
}

/* ─────────── Вечерняя сводка ─────────── */

export async function postDailyDigest(api: Api): Promise<void> {
  const chat = config.ACCOUNTANT_CHAT_ID;
  if (!chat) return;

  const db = await getDb();
  const stats = await db
    .select({ status: esfQueue.status, n: sql<number>`count(*)::int` })
    .from(esfQueue)
    .groupBy(esfQueue.status);

  const by = Object.fromEntries(stats.map((s) => [s.status, s.n]));
  const posted = by['posted'] ?? 0;
  const issued = by['issued'] ?? 0;
  const problem = by['problem'] ?? 0;

  const today = new Date(Date.now() + config.TZ_OFFSET_HOURS * 3600_000)
    .toISOString().slice(0, 10);

  const text = [
    `<b>Сводка по ЭСФ · ${fmtDate(today)}</b>`,
    '',
    `Выставлено: <b>${issued}</b>`,
    `В работе: <b>${posted}</b>`,
    problem ? `Проблемные: <b>${problem}</b>` : '',
    '',
    posted === 0 && problem === 0
      ? '<i>Всё закрыто.</i>'
      : '<i>Незакрытые карточки напомнят о себе через 24 часа.</i>',
  ].filter(Boolean).join('\n');

  await send(api, {
    dedupeKey: `esf:digest:${today}`,
    kind: 'esf_digest',
    chatId: chat,
    text,
    audience: 'staff',
    channel: 'B',
  });
}
