import type { Api } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { eq, desc } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { requests, messages, customers } from '../db/schema.js';
import { extractRequest, type Extracted } from '../ai/extract.js';
import { send } from './send.js';
import { log } from '../lib/logger.js';
import { fmtAmount } from '../lib/money.js';

/**
 * Полуавтомат.
 *
 * Бот клиенту не отвечает. Он превращает каждое обращение в карточку
 * в рабочей группе, а сотрудники разбираются сами. Ответ сотрудника
 * из группы бот доставляет клиенту от имени аккаунта.
 *
 * Смысл: вся переписка собирается в одном месте, ничего не теряется,
 * видно кто чем занят — но ни одного решения бот не принимает.
 */

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const STATUS_LABEL: Record<string, string> = {
  new: '🔴 новое',
  in_work: '🟡 в работе',
  done: '🟢 готово',
};

export interface IncomingRequest {
  chatId: number;
  messageId: number;
  businessConnectionId?: string;
  clientName: string;
  username?: string;
  text: string;
  /** Если прислали не текст */
  attachmentKind?: string;
}

function renderCard(r: {
  id: number;
  clientName: string;
  username: string | null;
  text: string;
  status: string;
  takenByName: string | null;
  extracted: Extracted | null;
  attachmentKind: string | null;
}): string {
  const x = r.extracted;
  const lines: string[] = [];

  const head = x?.isOrder ? '🛒 Заказ' : x?.aboutDocuments ? '📄 Документы' : '💬 Обращение';
  lines.push(`<b>${head} №${r.id}</b>  ${STATUS_LABEL[r.status] ?? r.status}`);
  lines.push('');
  lines.push(`От: <b>${esc(r.clientName)}</b>${r.username ? ` @${esc(r.username)}` : ''}`);

  if (r.attachmentKind) {
    lines.push(`Прислал: <b>${esc(r.attachmentKind)}</b>`);
  }

  lines.push('');
  lines.push(`<i>${esc(r.text).slice(0, 900)}</i>`);

  // Разобранный заказ — по юрлицам, чтобы не смешивались
  if (x?.orders?.length) {
    lines.push('');
    for (const o of x.orders) {
      if (o.entity) lines.push(`<b>${esc(o.entity)}</b>`);
      for (const it of o.items) {
        const qty = it.qty != null ? ` — ${fmtAmount(it.qty)}${it.unit ? ' ' + esc(it.unit) : ''}` : '';
        lines.push(`  • ${esc(it.name)}${qty}`);
      }
    }
  }

  if (x?.questions?.length) {
    lines.push('');
    lines.push('<b>Вопросы:</b>');
    for (const q of x.questions) lines.push(`  — ${esc(q)}`);
  }

  if (r.takenByName) {
    lines.push('');
    lines.push(`Взял: <b>${esc(r.takenByName)}</b>`);
  }

  lines.push('');
  lines.push('<i>Ответьте на это сообщение — бот отправит текст клиенту.</i>');

  return lines.join('\n');
}

function cardKeyboard(id: number, status: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (status === 'new') kb.text('Взять в работу', `req:take:${id}`);
  if (status !== 'done') kb.text('Готово', `req:done:${id}`);
  kb.row().text('Показать клиента', `req:who:${id}`);
  return kb;
}

/** Клиент написал — заводим карточку в группе */
export async function handleIncoming(api: Api, r: IncomingRequest): Promise<void> {
  const chat = config.ASSIST_CHAT_ID || config.MANAGER_CHAT_ID;
  if (!chat) {
    log.warn('Полуавтомат: не задан ASSIST_CHAT_ID — карточку некуда отправлять');
    return;
  }

  const db = await getDb();

  // Разбираем текст. Не получилось — покажем сырым, это не повод терять обращение.
  const extracted = r.text ? await extractRequest(r.text) : null;

  const [row] = await db.insert(requests).values({
    chatId: r.chatId,
    businessConnectionId: r.businessConnectionId ?? null,
    clientName: r.clientName,
    username: r.username ?? null,
    text: r.text || `[${r.attachmentKind ?? 'вложение'}]`,
    attachmentKind: r.attachmentKind ?? null,
    extracted: extracted ?? null,
    summary: extracted?.summary ?? r.text.slice(0, 120),
    status: 'new',
  }).returning();

  if (!row) return;

  const res = await send(api, {
    dedupeKey: `req:${r.chatId}:${r.messageId}`,
    kind: 'assist_card',
    chatId: chat,
    text: renderCard({
      id: row.id,
      clientName: r.clientName,
      username: r.username ?? null,
      text: r.text || `[${r.attachmentKind ?? 'вложение'}]`,
      status: 'new',
      takenByName: null,
      extracted,
      attachmentKind: r.attachmentKind ?? null,
    }),
    audience: 'staff',
    channel: 'B',
    keyboard: cardKeyboard(row.id, 'new'),
  });

  if (res.sent) {
    await db.update(requests)
      .set({ cardChatId: Number(chat), cardMessageId: res.messageId })
      .where(eq(requests.id, row.id));
    log.info(`Полуавтомат: обращение №${row.id} — карточка в группе`);
  }
}

/** Кнопки на карточке */
export async function handleAssistCallback(
  data: string,
  userId: number,
  userName: string,
): Promise<{ answer: string; alert?: boolean; edit?: string; keyboard?: InlineKeyboard }> {
  const [, action, idRaw] = data.split(':');
  const id = Number(idRaw);
  if (!Number.isFinite(id)) return { answer: 'Не разобрал обращение' };

  const db = await getDb();
  const [r] = await db.select().from(requests).where(eq(requests.id, id)).limit(1);
  if (!r) return { answer: 'Обращение не найдено' };

  if (action === 'who') {
    const [c] = await db.select().from(customers)
      .where(eq(customers.tgUserId, r.chatId)).limit(1);
    return {
      answer: `${r.clientName}${r.username ? ` @${r.username}` : ''}`
        + (c?.phone ? `\n${c.phone}` : '')
        + `\nchat_id: ${r.chatId}`,
      alert: true,
    };
  }

  let status = r.status;
  let takenByName = r.takenByName;

  if (action === 'take') {
    if (r.status !== 'new') return { answer: `Уже взял: ${r.takenByName ?? 'кто-то'}`, alert: true };
    status = 'in_work';
    takenByName = userName;
    await db.update(requests).set({
      status, takenByName, takenByUserId: userId, takenAt: new Date(),
    }).where(eq(requests.id, id));
  } else if (action === 'done') {
    status = 'done';
    await db.update(requests).set({
      status, closedByName: userName, closedAt: new Date(),
    }).where(eq(requests.id, id));
  } else {
    return { answer: 'Неизвестная кнопка' };
  }

  return {
    answer: action === 'take' ? 'Взяли в работу' : 'Закрыто',
    edit: renderCard({
      id: r.id,
      clientName: r.clientName,
      username: r.username,
      text: r.text,
      status,
      takenByName,
      extracted: (r.extracted as Extracted | null) ?? null,
      attachmentKind: r.attachmentKind,
    }),
    keyboard: cardKeyboard(id, status),
  };
}

/**
 * Сотрудник ответил на карточку в группе — доставляем текст клиенту.
 * Это единственный способ, которым в полуавтомате что-то уходит клиенту:
 * текст всегда написан человеком.
 */
export async function relayStaffReply(
  api: Api,
  replyToMessageId: number,
  text: string,
  staffName: string,
): Promise<{ ok: boolean; note: string }> {
  const db = await getDb();

  const [r] = await db.select().from(requests)
    .where(eq(requests.cardMessageId, replyToMessageId))
    .orderBy(desc(requests.id))
    .limit(1);

  if (!r) return { ok: false, note: 'Это сообщение не карточка обращения' };

  try {
    const sent = await api.sendMessage(r.chatId, text, {
      ...(r.businessConnectionId
        ? { business_connection_id: r.businessConnectionId }
        : {}),
    });

    await db.insert(messages).values({
      channel: 'A',
      chatId: r.chatId,
      tgMessageId: sent.message_id,
      direction: 'out',
      author: 'human',
      text,
      mode: config.MODE,
    });

    await db.update(requests).set({
      status: r.status === 'new' ? 'in_work' : r.status,
      takenByName: r.takenByName ?? staffName,
      repliedAt: new Date(),
    }).where(eq(requests.id, r.id));

    log.info(`Полуавтомат: ответ ${staffName} доставлен клиенту (обращение №${r.id})`);
    return { ok: true, note: `Отправлено клиенту ${r.clientName}` };
  } catch (e) {
    const msg = (e as Error).message;
    log.error('Не удалось доставить ответ клиенту', msg);
    return { ok: false, note: `Не доставлено: ${msg}` };
  }
}
