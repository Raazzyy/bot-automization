import type { Api } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { outbox } from '../db/schema.js';
import { log } from '../lib/logger.js';

export type Audience = 'staff' | 'client';

export interface SendOptions {
  dedupeKey: string;
  kind: string;
  chatId: number | string;
  text: string;
  audience: Audience;
  channel: 'A' | 'B';
  keyboard?: InlineKeyboardMarkup;
  businessConnectionId?: string;
}

export type SendOutcome =
  | { sent: true; messageId: number }
  | { sent: false; reason: 'duplicate' | 'mode' | 'no_chat' | 'error'; detail?: string };

function allowedByMode(audience: Audience): boolean {
  switch (config.MODE) {
    case 'live': return true;
    case 'assist': return audience === 'staff';
    case 'shadow': return audience === 'staff';
    case 'dry_run': return false;
  }
}

export async function send(api: Api, o: SendOptions): Promise<SendOutcome> {
  const db = await getDb();

  if (!o.chatId) {
    log.warn(`[${o.kind}] chat_id не задан — пропуск`);
    return { sent: false, reason: 'no_chat' };
  }

  try {
    await db.insert(outbox).values({
      dedupeKey: o.dedupeKey,
      channel: o.channel,
      chatId: typeof o.chatId === 'number' ? o.chatId : null,
      kind: o.kind,
      payload: { text: o.text, audience: o.audience },
      status: 'pending',
    });
  } catch {
    log.debug(`[${o.kind}] уже отправляли (${o.dedupeKey}) — пропуск`);
    return { sent: false, reason: 'duplicate' };
  }

  if (!allowedByMode(o.audience)) {
    await db.update(outbox)
      .set({ status: 'skipped', error: `режим ${config.MODE}` })
      .where(eq(outbox.dedupeKey, o.dedupeKey));

    log.info(`[${config.MODE}] не отправлено (${o.kind} → ${o.chatId}):\n${indent(o.text)}`);
    return { sent: false, reason: 'mode' };
  }

  try {
    const msg = await api.sendMessage(o.chatId, o.text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(o.businessConnectionId
        ? { business_connection_id: o.businessConnectionId }
        : o.keyboard
          ? { reply_markup: o.keyboard }
          : {}),
    });

    await db.update(outbox)
      .set({ status: 'sent', sentAt: new Date() })
      .where(eq(outbox.dedupeKey, o.dedupeKey));

    return { sent: true, messageId: msg.message_id };
  } catch (e: any) {
    const migrateTo = e?.parameters?.migrate_to_chat_id;
    if (migrateTo) {
      log.warn(`Чат ${o.chatId} преобразован Telegram в супергруппу ${migrateTo}. Повторная отправка...`);
      try {
        const retryMsg = await api.sendMessage(migrateTo, o.text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(o.keyboard ? { reply_markup: o.keyboard } : {}),
        });
        await db.update(outbox)
          .set({ status: 'sent', sentAt: new Date(), chatId: migrateTo })
          .where(eq(outbox.dedupeKey, o.dedupeKey));
        return { sent: true, messageId: retryMsg.message_id };
      } catch (retryErr: any) {
        log.error(`Повторная отправка в супергруппу ${migrateTo} не удалась:`, retryErr.message);
      }
    }

    const detail = (e as Error).message;
    await db.update(outbox)
      .set({ status: 'failed', error: detail })
      .where(eq(outbox.dedupeKey, o.dedupeKey));
    log.error(`[${o.kind}] отправка не прошла → ${o.chatId}`, detail);
    return { sent: false, reason: 'error', detail };
  }
}

function indent(s: string): string {
  return s.split('\n').map((l) => `      │ ${l.replace(/<[^>]+>/g, '')}`).join('\n');
}

export function businessChatAllowed(chatId: number | string): { ok: boolean; why?: string } {
  const id = String(chatId);
  if (config.BUSINESS_BLOCKLIST.includes(id)) {
    return { ok: false, why: 'чат в списке исключений' };
  }
  if (config.BUSINESS_ALLOWLIST.length && !config.BUSINESS_ALLOWLIST.includes(id)) {
    return { ok: false, why: 'чат вне белого списка пилота' };
  }
  return { ok: true };
}
