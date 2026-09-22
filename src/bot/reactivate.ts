import type { Api } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { eq, inArray, desc, and } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import {
  markets, orders, orderItems, customers, channelBindings, messages, outbox,
} from '../db/schema.js';
import { config } from '../config.js';
import { send } from './send.js';
import { fmtDate, fmtSum, todayTashkent, daysAgo } from '../lib/money.js';
import { log } from '../lib/logger.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface DormantMarket {
  marketId: number;
  marketName: string;
  marketInn: string | null;
  phone: string | null;
  ordersCount: number;
  lastOrderDate: string;
  daysSinceLast: number;
  medianIntervalDays: number;
  daysOverdueCycle: number;
  topProducts: { name: string; amountTotal: number; ordersCount: number }[];
  draftMessageRu: string;
  draftMessageUz: string;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export async function findDormantMarkets(): Promise<DormantMarket[]> {
  const db = await getDb();
  const allMarkets = await db.select().from(markets);
  const dormant: DormantMarket[] = [];

  for (const m of allMarkets) {
    const mOrders = await db
      .select({
        id: orders.id,
        createdDate: orders.createdDate,
        dateDelivery: orders.dateDelivery,
        totalPrice: orders.totalPrice,
      })
      .from(orders)
      .where(and(
        eq(orders.marketId, m.id),
        inArray(orders.status, ['delivered', 'given', 'success']),
      ))
      .orderBy(orders.createdDate, orders.id);

    if (!mOrders.length) continue;

    const lastOrder = mOrders.at(-1)!;
    const lastDate = lastOrder.createdDate ?? lastOrder.dateDelivery;
    const daysSinceLast = Math.max(0, daysAgo(lastDate, config.TZ_OFFSET_HOURS) ?? 0);

    let medianIntervalDays = 7;
    let isDormant = false;
    let daysOverdueCycle = 0;

    if (mOrders.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < mOrders.length; i++) {
        const prev = mOrders[i - 1]!.createdDate;
        const cur = mOrders[i]!.createdDate;
        if (prev && cur) {
          const d1 = Date.parse(prev);
          const d2 = Date.parse(cur);
          if (Number.isFinite(d1) && Number.isFinite(d2)) {
            const diffDays = Math.max(1, Math.round(Math.abs(d2 - d1) / 86_400_000));
            intervals.push(diffDays);
          }
        }
      }

      if (intervals.length) {
        medianIntervalDays = Math.max(3, median(intervals));
      }

      const threshold = Math.max(7, Math.round(medianIntervalDays * 1.4));
      if (daysSinceLast >= threshold) {
        isDormant = true;
        daysOverdueCycle = daysSinceLast - medianIntervalDays;
      }
    } else {
      if (daysSinceLast >= 12) {
        isDormant = true;
        daysOverdueCycle = daysSinceLast - 7;
        medianIntervalDays = 7;
      }
    }

    if (!isDormant) continue;

    const orderIds = mOrders.map((o) => o.id);
    const items = await db
      .select({
        productId: orderItems.productId,
        productName: orderItems.productName,
        amount: orderItems.amount,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds));

    const productStats = new Map<string, { amountTotal: number; ordersCount: number }>();
    for (const it of items) {
      const name = it.productName || `Товар #${it.productId}`;
      const stat = productStats.get(name) ?? { amountTotal: 0, ordersCount: 0 };
      stat.amountTotal += Number(it.amount ?? 0);
      stat.ordersCount += 1;
      productStats.set(name, stat);
    }

    const topProducts = [...productStats.entries()]
      .map(([name, stat]) => ({ name, ...stat }))
      .sort((a, b) => b.ordersCount - a.ordersCount || b.amountTotal - a.amountTotal)
      .slice(0, 2);

    const topNamesRu = topProducts.length
      ? topProducts.map((p) => p.name).join(' и ')
      : 'наши основные позиции';

    const topNamesUz = topProducts.length
      ? topProducts.map((p) => p.name).join(' va ')
      : 'mahsulotlarimiz';

    const phones = (m.phones as string[]) ?? [];
    const phone = phones[0] ?? null;

    const draftMessageRu = [
      `Ассалому алейкум! Давно не оформляли доставку для «${m.name}».`,
      `У вас случайно не заканчиваются ${topNamesRu}?`,
      `На этой неделе у нас свежее поступление на складе — можем привезти завтра к удобному для вас времени.`,
      `Подготовить и забронировать заказ?`,
    ].join('\n\n');

    const draftMessageUz = [
      `Assalomu alaykum! «${m.name}» uchun ancha vaqtdan beri buyurtma bermadingiz.`,
      `Sizda ${topNamesUz} tugab qolmadimi?`,
      `Bu hafta omborimizga yangi partiya keldi — ertaga qulay vaqtda yetkazib berishimiz mumkin.`,
      `Buyurtma tayyorlab qo‘yaylikmi?`,
    ].join('\n\n');

    dormant.push({
      marketId: m.id,
      marketName: m.name,
      marketInn: m.inn,
      phone,
      ordersCount: mOrders.length,
      lastOrderDate: lastDate ?? todayTashkent(),
      daysSinceLast,
      medianIntervalDays,
      daysOverdueCycle,
      topProducts,
      draftMessageRu,
      draftMessageUz,
    });
  }

  dormant.sort((a, b) => b.daysOverdueCycle - a.daysOverdueCycle);
  return dormant;
}

export function renderReactivationCard(d: DormantMarket): string {
  const lines: string[] = [];

  lines.push(`<b>💤 Спящий клиент · Нужна реактивация</b>`);
  lines.push('');
  lines.push(`Точка: <b>${esc(d.marketName)}</b>`);
  if (d.marketInn) lines.push(`ИНН: <code>${esc(d.marketInn)}</code>`);
  lines.push(`Тел: ${d.phone ? `<code>${esc(d.phone)}</code>` : '<i>не указан</i>'}`);
  lines.push('');
  lines.push('<b>Анализ поведения:</b>');
  lines.push(`• Обычный цикл: <b>каждые ${d.medianIntervalDays} дн.</b> (всего заказов: ${d.ordersCount})`);
  lines.push(`• Последний заказ: <b>${fmtDate(d.lastOrderDate)}</b> (${d.daysSinceLast} дн. назад)`);
  lines.push(`• Задержка цикла: <b>+${d.daysOverdueCycle} дн.</b>`);
  lines.push('');

  if (d.topProducts.length) {
    lines.push('<b>Регулярные товары точки:</b>');
    for (const p of d.topProducts) {
      lines.push(`  — ${esc(p.name)} (заказывали ${p.ordersCount} раз)`);
    }
    lines.push('');
  }

  lines.push('💬 <b>Предлагаемый текст клиенту (RU/UZ):</b>');
  lines.push(`<i>«${esc(d.draftMessageRu)}»</i>`);

  return lines.join('\n');
}

export function reactivationKeyboard(marketId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('🚀 Отправить клиенту', `m4:send:${marketId}`)
    .text('💤 Отложить 7 дн', `m4:snooze:${marketId}`)
    .row()
    .text('ℹ️ История точки', `m4:info:${marketId}`);
}

export async function postReactivationCards(
  api: Api,
  targetChatId?: string | number,
): Promise<number> {
  const chat = targetChatId || config.MANAGER_CHAT_ID || config.ACCOUNTANT_CHAT_ID;
  if (!chat) {
    log.warn('M4: MANAGER_CHAT_ID / ACCOUNTANT_CHAT_ID не задан');
    return 0;
  }

  const dormantList = await findDormantMarkets();
  if (!dormantList.length) {
    log.info('M4: спящих клиентов с нарушением цикла не обнаружено');
    return 0;
  }

  const batch = dormantList.slice(0, 5);
  let posted = 0;

  for (const d of batch) {
    const text = renderReactivationCard(d);
    const keyboard = reactivationKeyboard(d.marketId);

    const res = await send(api, {
      dedupeKey: `m4:card:${d.marketId}:${d.lastOrderDate}`,
      kind: 'reactivation_card',
      chatId: chat,
      text,
      audience: 'staff',
      channel: 'B',
      keyboard,
    });

    if (res.sent) posted++;
  }

  log.info(`M4: опубликовано карточек реактивации: ${posted} (всего кандидатов: ${dormantList.length})`);
  return posted;
}

export async function handleReactivationCallback(
  api: Api,
  data: string,
  userId: number,
  userName: string,
): Promise<{ answer: string; alert?: boolean; edit?: string; keyboard?: InlineKeyboard }> {
  const parts = data.split(':');
  const action = parts[1];
  const marketId = Number(parts[2]);
  if (!Number.isFinite(marketId)) return { answer: 'Неверный ID точки' };

  const db = await getDb();
  const dormantList = await findDormantMarkets();
  const target = dormantList.find((d) => d.marketId === marketId);

  if (action === 'snooze') {
    return {
      answer: 'Отложено на 7 дней',
      edit: target
        ? `${renderReactivationCard(target)}\n\n⏸ <b>Отложено на 7 дней</b> — ${esc(userName)}`
        : undefined,
    };
  }

  if (action === 'info') {
    const [m] = await db.select().from(markets).where(eq(markets.id, marketId)).limit(1);
    const mOrders = await db.select().from(orders)
      .where(eq(orders.marketId, marketId))
      .orderBy(desc(orders.id))
      .limit(5);

    const lines = [
      `<b>История заказов · ${esc(m?.name ?? `Точка #${marketId}`)}</b>`,
      `Всего заказов: ${mOrders.length}`,
      '',
    ];

    for (const o of mOrders) {
      lines.push(
        `• Заказ №${o.id} от ${fmtDate(o.createdDate)} — ${fmtSum(o.totalPrice)} (${o.status})`,
      );
    }

    const staffChat = config.MANAGER_CHAT_ID || config.ACCOUNTANT_CHAT_ID;
    if (staffChat) {
      await send(api, {
        dedupeKey: `m4:info:${marketId}:${Date.now()}`,
        kind: 'm4_info',
        chatId: staffChat,
        text: lines.join('\n'),
        audience: 'staff',
        channel: 'B',
      });
    }

    return { answer: 'История выгружена в чат' };
  }

  if (action === 'send') {
    if (!target) {
      return { answer: 'Данные точки не найдены в списке спящих', alert: true };
    }

    const allCusts = await db.select().from(customers);
    const cust = allCusts.find((c) => (c.marketIds as number[]).includes(marketId));

    let targetChatId: number | null = null;
    let businessConnId: string | null = null;

    if (cust) {
      const [bindA] = await db.select().from(channelBindings)
        .where(and(
          eq(channelBindings.customerId, cust.id),
          eq(channelBindings.channel, 'A'),
        )).limit(1);

      if (bindA) {
        targetChatId = bindA.chatId;
        businessConnId = bindA.businessConnectionId ?? null;
      } else {
        const [bindB] = await db.select().from(channelBindings)
          .where(and(
            eq(channelBindings.customerId, cust.id),
            eq(channelBindings.channel, 'B'),
          )).limit(1);
        if (bindB) targetChatId = bindB.chatId;
      }
    }

    const textToSend = target.draftMessageRu;

    if (targetChatId) {
      try {
        const sent = await api.sendMessage(targetChatId, textToSend, {
          ...(businessConnId ? { business_connection_id: businessConnId } : {}),
        });

        await db.insert(messages).values({
          channel: businessConnId ? 'A' : 'B',
          chatId: targetChatId,
          tgMessageId: sent.message_id,
          direction: 'out',
          author: 'human',
          text: textToSend,
          mode: config.MODE,
        });

        log.info(`M4: сообщение реактивации отправлено клиенту точки «${target.marketName}» (${userName})`);

        return {
          answer: 'Сообщение успешно отправлено клиенту!',
          edit: `${renderReactivationCard(target)}\n\n🟢 <b>Отправлено клиенту</b> — ${esc(userName)}`,
        };
      } catch (e) {
        log.error('M4: ошибка отправки клиенту', (e as Error).message);
      }
    }

    const staffChat = config.MANAGER_CHAT_ID || config.ACCOUNTANT_CHAT_ID;
    if (staffChat) {
      const prompt = [
        `📱 <b>Реактивация · Готовый текст для связи с «${esc(target.marketName)}»</b>`,
        `Сотрудник: ${esc(userName)}`,
        target.phone ? `Телефон: <code>${esc(target.phone)}</code>` : 'Тел: <i>не указан</i>',
        '',
        '<i>Прямой чат Telegram с клиентом пока не привязан. Скопируйте готовый текст для отправки по SMS / звонка:</i>',
        '',
        `<code>${esc(textToSend)}</code>`,
      ].join('\n');

      await send(api, {
        dedupeKey: `m4:note:${marketId}:${Date.now()}`,
        kind: 'm4_prompt',
        chatId: staffChat,
        text: prompt,
        audience: 'staff',
        channel: 'B',
      });
    }

    return {
      answer: 'Прямого чата нет — текст и телефон высланы в группу для звонка/SMS',
      alert: true,
      edit: `${renderReactivationCard(target)}\n\n🟡 <b>Текст выгружен менеджеру для связи</b> — ${esc(userName)}`,
    };
  }

  return { answer: 'Неизвестное действие' };
}
