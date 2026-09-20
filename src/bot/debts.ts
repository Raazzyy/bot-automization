import type { Api } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import { eq, inArray, and, desc, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import {
  orders, payments, markets, debtSnapshots,
  customers, channelBindings, messages, outbox,
} from '../db/schema.js';
import { config } from '../config.js';
import { send } from './send.js';
import { fmtSum, fmtDate, fmtNum, todayTashkent, daysAgo, toSum } from '../lib/money.js';
import { log } from '../lib/logger.js';
import { generateReconciliationPdf } from '../lib/pdf-waybill.js';
import { getCompanyProfile } from '../lib/settings.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface DebtMarketSummary {
  marketId: number;
  marketName: string;
  marketInn: string | null;
  phone: string | null;
  debtTotal: number;
  overdue: number;
  bucket0007: number;
  bucket0830: number;
  bucket3160: number;
  bucket60p: number;
  maxOverdueDays: number;
}

export interface DebtOverview {
  date: string;
  totalDebt: number;
  totalOverdue: number;
  bucket0007: number;
  bucket0830: number;
  bucket3160: number;
  bucket60p: number;
  debtorsCount: number;
  debtors: DebtMarketSummary[];
}

/**
 * Рассчитывает баланс и старение дебиторской задолженности по всем точкам.
 * По правилам FIFO: оплаты в первую очередь гасят старые заказы.
 */
export async function calculateDebts(): Promise<DebtOverview> {
  const db = await getDb();
  const today = todayTashkent(config.TZ_OFFSET_HOURS);

  // 1. Все доставленные/отгруженные заказы
  const allOrders = await db
    .select({
      id: orders.id,
      marketId: orders.marketId,
      marketName: orders.marketName,
      marketInn: orders.marketInn,
      totalPrice: orders.totalPrice,
      createdDate: orders.createdDate,
      paymentDate: orders.paymentDate,
      dateDelivery: orders.dateDelivery,
      status: orders.status,
    })
    .from(orders)
    .where(inArray(orders.status, ['delivered', 'given', 'success']))
    .orderBy(orders.createdDate, orders.id);

  // 2. Все проведённые оплаты
  const allPayments = await db
    .select({
      id: payments.id,
      marketId: payments.marketId,
      amount: payments.amount,
      status: payments.status,
    })
    .from(payments)
    .where(and(
      eq(payments.status, 'accepted'),
      eq(payments.isDelete, false),
    ));

  // 3. Данные по точкам (телефоны, названия)
  const allMarkets = await db.select().from(markets);
  const marketMap = new Map(allMarkets.map((m) => [m.id, m]));

  // Группируем заказы и оплаты по marketId
  const ordersByMarket = new Map<number, typeof allOrders>();
  for (const o of allOrders) {
    if (o.marketId == null) continue;
    const list = ordersByMarket.get(o.marketId) ?? [];
    list.push(o);
    ordersByMarket.set(o.marketId, list);
  }

  const paymentsByMarket = new Map<number, number>();
  for (const p of allPayments) {
    if (p.marketId == null) continue;
    const cur = paymentsByMarket.get(p.marketId) ?? 0;
    paymentsByMarket.set(p.marketId, cur + toSum(p.amount));
  }

  const debtors: DebtMarketSummary[] = [];

  for (const [marketId, mOrders] of ordersByMarket.entries()) {
    const market = marketMap.get(marketId);
    const marketName = market?.name ?? mOrders[0]?.marketName ?? `Точка #${marketId}`;
    const marketInn = market?.inn ?? mOrders[0]?.marketInn ?? null;
    const phones = (market?.phones as string[]) ?? [];
    const phone = phones[0] ?? null;

    let availablePayments = paymentsByMarket.get(marketId) ?? 0;

    let debtTotal = 0;
    let overdue = 0;
    let bucket0007 = 0;
    let bucket0830 = 0;
    let bucket3160 = 0;
    let bucket60p = 0;
    let maxOverdueDays = 0;

    // FIFO: списываем оплаты от самых старых заказов к новым
    for (const o of mOrders) {
      const price = toSum(o.totalPrice);
      if (availablePayments >= price) {
        availablePayments -= price;
      } else {
        const unpaid = price - availablePayments;
        availablePayments = 0;
        debtTotal += unpaid;

        // Дата, от которой отсчитывается просрочка: paymentDate (отсрочка) или createdDate
        const baseDate = o.paymentDate || o.dateDelivery || o.createdDate;
        const days = Math.max(0, daysAgo(baseDate, config.TZ_OFFSET_HOURS) ?? 0);

        if (days <= 7) {
          bucket0007 += unpaid;
        } else if (days <= 30) {
          bucket0830 += unpaid;
          overdue += unpaid;
          if (days > maxOverdueDays) maxOverdueDays = days;
        } else if (days <= 60) {
          bucket3160 += unpaid;
          overdue += unpaid;
          if (days > maxOverdueDays) maxOverdueDays = days;
        } else {
          bucket60p += unpaid;
          overdue += unpaid;
          if (days > maxOverdueDays) maxOverdueDays = days;
        }
      }
    }

    if (debtTotal > 0) {
      debtors.push({
        marketId,
        marketName,
        marketInn,
        phone,
        debtTotal,
        overdue,
        bucket0007,
        bucket0830,
        bucket3160,
        bucket60p,
        maxOverdueDays,
      });

      // Сохраняем ежедневный срез в базу
      await db.insert(debtSnapshots).values({
        date: today,
        marketId,
        debtTotal: String(debtTotal),
        overdue: String(overdue),
        bucket0007: String(bucket0007),
        bucket0830: String(bucket0830),
        bucket3160: String(bucket3160),
        bucket60p: String(bucket60p),
      }).onConflictDoUpdate({
        target: [debtSnapshots.date, debtSnapshots.marketId],
        set: {
          debtTotal: String(debtTotal),
          overdue: String(overdue),
          bucket0007: String(bucket0007),
          bucket0830: String(bucket0830),
          bucket3160: String(bucket3160),
          bucket60p: String(bucket60p),
        },
      });
    }
  }

  // Сортируем: сначала самые крупные должники
  debtors.sort((a, b) => b.debtTotal - a.debtTotal);

  const totalDebt = debtors.reduce((s, d) => s + d.debtTotal, 0);
  const totalOverdue = debtors.reduce((s, d) => s + d.overdue, 0);
  const totalB07 = debtors.reduce((s, d) => s + d.bucket0007, 0);
  const totalB0830 = debtors.reduce((s, d) => s + d.bucket0830, 0);
  const totalB3160 = debtors.reduce((s, d) => s + d.bucket3160, 0);
  const totalB60p = debtors.reduce((s, d) => s + d.bucket60p, 0);

  return {
    date: today,
    totalDebt,
    totalOverdue,
    bucket0007: totalB07,
    bucket0830: totalB0830,
    bucket3160: totalB3160,
    bucket60p: totalB60p,
    debtorsCount: debtors.length,
    debtors,
  };
}

/**
 * Формирует текст сводки по задолженности
 */
export function buildDebtSummaryText(overview: DebtOverview): string {
  const lines: string[] = [];
  const overduePercent = overview.totalDebt > 0
    ? Math.round((overview.totalOverdue / overview.totalDebt) * 100)
    : 0;

  lines.push(`<b>📊 Дебиторская задолженность · ${fmtDate(overview.date)}</b>`);
  lines.push('');
  lines.push(`Общий долг: <b>${fmtSum(overview.totalDebt)}</b>`);
  lines.push(`Просрочено: <b>${fmtSum(overview.totalOverdue)}</b> (${overduePercent}%)`);
  lines.push(`Точек с долгом: <b>${overview.debtorsCount}</b>`);
  lines.push('');
  lines.push('<b>Старение задолженности:</b>');
  lines.push(`🟢 0–7 дн. (текущий): ${fmtSum(overview.bucket0007)}`);
  lines.push(`🟡 8–30 дн. (допустимая): ${fmtSum(overview.bucket0830)}`);
  lines.push(`🟠 31–60 дн. (критичная): ${fmtSum(overview.bucket3160)}`);
  lines.push(`🔴 60+ дн. (стоп-отгрузка): ${fmtSum(overview.bucket60p)}`);
  lines.push('');

  if (overview.debtors.length > 0) {
    lines.push('<b>Топ должников:</b>');
    const top = overview.debtors.slice(0, 5);
    for (const [i, d] of top.entries()) {
      const overNote = d.overdue > 0 ? ` · ⚠️ проср. ${d.maxOverdueDays} дн.` : ' · текущий';
      lines.push(
        `${i + 1}. <b>${esc(d.marketName)}</b>\n`
        + `   Долг: <b>${fmtSum(d.debtTotal)}</b>${overNote}\n`
        + `   ИНН: <code>${esc(d.marketInn ?? '—')}</code>${d.phone ? ` · Тел: ${esc(d.phone)}` : ''}`,
      );
    }
  } else {
    lines.push('<i>Задолженностей нет. Все отгрузки оплачены!</i>');
  }

  return lines.join('\n');
}

/**
 * Клавиатура для управления долгами: кнопки напоминания клиентам
 */
export function buildDebtKeyboard(debtors: DebtMarketSummary[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Добавляем кнопки напоминания и акт сверки для топ-3 должников с просрочкой
  const needReminder = debtors.filter((d) => d.debtTotal > 0).slice(0, 3);
  for (const d of needReminder) {
    const shortName = d.marketName.length > 13
      ? `${d.marketName.slice(0, 11)}…`
      : d.marketName;
    kb.text(`🔔 ${shortName}`, `debt:remind:${d.marketId}`)
      .text(`📄 Сверка PDF`, `debt:act:${d.marketId}`)
      .row();
  }

  kb.text('📋 Полный список', 'debt:all')
    .text('🔄 Обновить', 'debt:refresh');

  return kb;
}

/**
 * Публикация сводки дебиторки в группу финотдела / бухгалтерии
 */
export async function postDebtSummary(api: Api, targetChatId?: string | number): Promise<void> {
  const chat = targetChatId || config.FINANCE_CHAT_ID || config.ACCOUNTANT_CHAT_ID;
  if (!chat) {
    log.warn('M5: FINANCE_CHAT_ID / ACCOUNTANT_CHAT_ID не задан — сводка не опубликована');
    return;
  }

  const overview = await calculateDebts();
  const text = buildDebtSummaryText(overview);
  const keyboard = buildDebtKeyboard(overview.debtors);

  await send(api, {
    dedupeKey: `debt:summary:${overview.date}:${Date.now()}`,
    kind: 'debt_summary',
    chatId: chat,
    text,
    audience: 'staff',
    channel: 'B',
    keyboard,
  });

  log.info(`M5: сводка дебиторки отправлена в чат ${chat}`);
}

/**
 * Обработка нажатий на инлайн-кнопки дебиторки
 */
export async function handleDebtCallback(
  api: Api,
  data: string,
  userId: number,
  userName: string,
): Promise<{ answer: string; alert?: boolean; edit?: string; keyboard?: InlineKeyboard }> {
  const parts = data.split(':');
  const action = parts[1];
  const db = await getDb();

  if (action === 'refresh') {
    const overview = await calculateDebts();
    return {
      answer: 'Данные обновлены',
      edit: buildDebtSummaryText(overview),
      keyboard: buildDebtKeyboard(overview.debtors),
    };
  }

  if (action === 'all') {
    const overview = await calculateDebts();
    if (!overview.debtors.length) {
      return { answer: 'Должников нет', alert: true };
    }

    const lines = [
      `<b>📋 Полный реестр задолженности · ${fmtDate(overview.date)}</b>`,
      `Всего точек: <b>${overview.debtors.length}</b> на сумму <b>${fmtSum(overview.totalDebt)}</b>`,
      '',
    ];

    for (const [i, d] of overview.debtors.entries()) {
      const overdueTag = d.overdue > 0 ? ` (просрочка: ${fmtSum(d.overdue)}, макс. ${d.maxOverdueDays} дн.)` : ' (в сроке)';
      lines.push(
        `${i + 1}. <b>${esc(d.marketName)}</b>\n`
        + `   Долг: <b>${fmtSum(d.debtTotal)}</b>${overdueTag}\n`
        + `   ИНН: <code>${esc(d.marketInn ?? '—')}</code>${d.phone ? ` · Тел: ${esc(d.phone)}` : ''}`,
      );
    }

    const chat = config.FINANCE_CHAT_ID || config.ACCOUNTANT_CHAT_ID;
    if (chat) {
      await send(api, {
        dedupeKey: `debt:all:${Date.now()}`,
        kind: 'debt_full_list',
        chatId: chat,
        text: lines.join('\n'),
        audience: 'staff',
        channel: 'B',
      });
    }

    return { answer: 'Полный реестр отправлен в чат' };
  }

  if (action === 'remind') {
    const marketId = Number(parts[2]);
    if (!Number.isFinite(marketId)) return { answer: 'Неверный ID точки' };

    const overview = await calculateDebts();
    const debtor = overview.debtors.find((d) => d.marketId === marketId);
    if (!debtor) return { answer: 'Точка не найдена среди должников', alert: true };

    // Составляем вежливое напоминание
    const reminderText = [
      `Ассалому алейкум!`,
      `Напоминаем, что по данным бухгалтерской сверки за «${debtor.marketName}» числится задолженность в размере ${fmtSum(debtor.debtTotal)}.`
      + (debtor.maxOverdueDays > 7 ? ` (просрочка: ${debtor.maxOverdueDays} дн.).` : ''),
      '',
      `Просим произвести оплату или направить платежное поручение для сверки.`,
      `Если оплата уже отправлена, пожалуйста, пришлите квитанцию ответным сообщением.`,
      `Спасибо за сотрудничество!`,
    ].join('\n');

    // Ищем привязанный чат в канале A или B
    // 1) По прямому совпадению marketId в customers.marketIds
    const allCusts = await db.select().from(customers);
    const targetCust = allCusts.find((c) => (c.marketIds as number[]).includes(marketId));

    let targetChatId: number | null = null;
    let businessConnId: string | null = null;

    if (targetCust) {
      const [bindA] = await db.select().from(channelBindings)
        .where(and(
          eq(channelBindings.customerId, targetCust.id),
          eq(channelBindings.channel, 'A'),
        )).limit(1);

      if (bindA) {
        targetChatId = bindA.chatId;
        businessConnId = bindA.businessConnectionId ?? null;
      } else {
        const [bindB] = await db.select().from(channelBindings)
          .where(and(
            eq(channelBindings.customerId, targetCust.id),
            eq(channelBindings.channel, 'B'),
          )).limit(1);
        if (bindB) targetChatId = bindB.chatId;
      }
    }

    if (targetChatId) {
      try {
        const sent = await api.sendMessage(targetChatId, reminderText, {
          ...(businessConnId ? { business_connection_id: businessConnId } : {}),
        });

        await db.insert(messages).values({
          channel: businessConnId ? 'A' : 'B',
          chatId: targetChatId,
          tgMessageId: sent.message_id,
          direction: 'out',
          author: 'human',
          text: reminderText,
          mode: config.MODE,
        });

        log.info(`M5: напоминание о долге отправлено клиенту точки «${debtor.marketName}» (${userName})`);
        return {
          answer: `✅ Напоминание отправлено в чат «${debtor.marketName}»!`,
          alert: true,
        };
      } catch (e) {
        log.error('M5: ошибка при отправке напоминания', (e as Error).message);
      }
    }

    // Если прямого чата нет — публикуем в группу готовый блок для звонка / SMS
    const staffChat = config.FINANCE_CHAT_ID || config.ACCOUNTANT_CHAT_ID;
    if (staffChat) {
      const note = [
        `🔔 <b>Напоминание о задолженности · «${esc(debtor.marketName)}»</b>`,
        `Сотрудник: ${esc(userName)}`,
        debtor.phone ? `Тел: <code>${esc(debtor.phone)}</code>` : 'Тел: <i>не указан</i>',
        debtor.marketInn ? `ИНН: <code>${esc(debtor.marketInn)}</code>` : '',
        `Сумма долга: <b>${fmtSum(debtor.debtTotal)}</b>`,
        '',
        '<i>Прямой Telegram-чат с точкой ещё не привязан. Скопируйте текст для отправки по SMS / мессенджеру:</i>',
        '',
        `<code>${esc(reminderText)}</code>`,
      ].filter(Boolean).join('\n');

      await send(api, {
        dedupeKey: `debt:remind:note:${debtor.marketId}:${Date.now()}`,
        kind: 'debt_remind_note',
        chatId: staffChat,
        text: note,
        audience: 'staff',
        channel: 'B',
      });
    }

    return {
      answer: `Готовый текст напоминания для «${debtor.marketName}» выслан в группу для звонка/SMS`,
      alert: true,
    };
  }

  if (action === 'act') {
    const marketId = Number(parts[2]);
    if (!Number.isFinite(marketId)) return { answer: 'Неверный ID точки' };

    try {
      const [m] = await db.select().from(markets).where(eq(markets.id, marketId)).limit(1);
      const mName = m?.name ?? `Точка_${marketId}`;
      const pdfBuf = await generateReconciliationPdf(marketId);
      const company = await getCompanyProfile();

      const staffChat = config.FINANCE_CHAT_ID || config.ACCOUNTANT_CHAT_ID || config.ASSIST_CHAT_ID;
      await api.sendDocument(
        staffChat,
        new InputFile(pdfBuf, `Акт_сверки_${mName.replace(/[^\wа-яё]/gi, '_')}.pdf`),
        { caption: `📄 Официальный акт сверки расчетов с «${mName}» (${company.name})` },
      );
      return { answer: `Акт сверки для «${mName}» отправлен в чат!` };
    } catch (err) {
      log.error(`M5: ошибка генерации акта сверки для точки ${marketId}`, err);
      return { answer: `Ошибка: ${(err as Error).message}`, alert: true };
    }
  }

  return { answer: 'Неизвестная команда' };
}
