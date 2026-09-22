import { Bot } from 'grammy';
import { eq, sql, desc, and } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { businessConnections, customers, channelBindings, messages, esfQueue, markets } from '../db/schema.js';
import { log } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { send, businessChatAllowed } from './send.js';
import { runAgent } from '../ai/agent.js';
import { sendAttachments } from './media.js';
import { canSendToClients, isAssist } from '../config.js';
import { isBotEnabled, getActiveMode, getAllSettings } from '../lib/settings.js';
import { handleIncoming, handleAssistCallback, relayStaffReply } from './assist.js';
import { handleEsfCallback, postNewOrders, postNewPayments, postDailyDigest } from './esf.js';
import { downloadTelegramFile, transcribeAudio, extractOrderFromPhoto } from '../ai/media-ai.js';
import { recordManagerFeedback } from '../ai/chat-learner.js';
import { postDebtSummary, handleDebtCallback, calculateDebts } from './debts.js';
import { postReactivationCards, handleReactivationCallback, findDormantMarkets } from './reactivate.js';
import { fmtSum } from '../lib/money.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type NonText = 'photo' | 'document' | 'video' | 'voice' | 'audio'
  | 'sticker' | 'location' | 'contact' | 'other';

function describeNonText(msg: unknown): NonText | null {
  const m = msg as Record<string, unknown>;
  if (m['text']) return null;
  if (m['photo']) return 'photo';
  if (m['document']) return 'document';
  if (m['video']) return 'video';
  if (m['voice']) return 'voice';
  if (m['audio']) return 'audio';
  if (m['sticker']) return 'sticker';
  if (m['location'] || m['venue']) return 'location';
  if (m['contact']) return 'contact';
  return 'other';
}

const KIND_RU: Record<string, string> = {
  photo: 'фото', document: 'документ', video: 'видео',
  voice: 'голосовое', audio: 'аудио', sticker: 'стикер',
  location: 'локацию', contact: 'контакт', other: 'вложение',
};

const ACK_BY_KIND: Record<string, string> = {
  photo: 'Фото получили, сейчас посмотрим.',
  document: 'Документы получили, передаю коллегам.',
  video: 'Видео получили.',
  voice: 'Голосовое получили, коллега прослушает и ответит.',
  audio: 'Получили, передаю коллегам.',
  location: 'Локацию записали, передам в доставку.',
  contact: 'Контакт записали.',
  other: 'Получили, передаю коллегам.',
};

export function createBot(): Bot {
  const bot = new Bot(config.BOT_TOKEN);

  bot.use(async (ctx, next) => {
    const kinds = Object.keys(ctx.update).filter((k) => k !== 'update_id');
    const text = ctx.message?.text ?? ctx.businessMessage?.text ?? '';
    log.info(
      `← ${kinds.join(',')}`
      + (ctx.chat ? ` | чат ${ctx.chat.id} (${ctx.chat.type})` : '')
      + (text ? ` | «${text}»` : ''),
    );
    await next();
  });

  bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const chat = ctx.chat;
    log.info(`Бота ${status === 'left' || status === 'kicked' ? 'убрали из' : 'добавили в'} чат «${
      'title' in chat ? chat.title : chat.id}» — ID ${chat.id}`);

    if (status === 'member' || status === 'administrator') {
      await ctx.reply(
        `Бот на месте.\n\n<b>ID этого чата:</b> <code>${chat.id}</code>\n\n`
        + `Впишите в .env:\n<code>ACCOUNTANT_CHAT_ID=${chat.id}</code>`,
        { parse_mode: 'HTML' },
      ).catch((e) => log.error('Не смог написать в группу', e.message));
    }
  });

  bot.on('business_connection', async (ctx) => {
    const c = ctx.businessConnection;
    const db = await getDb();

    const raw = c as unknown as {
      can_reply?: boolean;
      rights?: { can_reply?: boolean };
      is_enabled?: boolean;
    };
    const canReply = raw.rights?.can_reply ?? raw.can_reply ?? false;
    const enabled = raw.is_enabled ?? true;

    await db.insert(businessConnections).values({
      id: c.id,
      ownerUserId: c.user.id,
      ownerUsername: c.user.username ?? null,
      canReply,
      isEnabled: enabled,
      rights: raw.rights ?? null,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: businessConnections.id,
      set: { canReply, isEnabled: enabled, rights: raw.rights ?? null, updatedAt: new Date() },
    });

    log.info(
      `Канал A: ${enabled ? 'подключён' : 'отключён'} аккаунт @${c.user.username ?? c.user.id}`,
      { connection: c.id, canReply },
    );

    if (enabled && !canReply) {
      log.warn('Канал A: нет права отвечать — в настройках Business включите боту доступ на ответ');
    }
  });

  bot.on('business_message', async (ctx) => {
    const msg = ctx.businessMessage;
    const connId = msg.business_connection_id;
    const chatId = msg.chat.id;
    const db = await getDb();

    const conn = connId
      ? (await db.select().from(businessConnections).where(eq(businessConnections.id, connId)).limit(1))[0]
      : undefined;

    const fromOwner = conn && ctx.from?.id === conn.ownerUserId;

    await db.insert(messages).values({
      channel: 'A',
      chatId,
      tgMessageId: msg.message_id,
      direction: fromOwner ? 'out' : 'in',
      author: fromOwner ? 'human' : 'client',
      text: msg.text ?? msg.caption
        ?? `[${KIND_RU[describeNonText(msg) ?? 'other'] ?? 'вложение'}]`,
      mode: config.MODE,
    });

    if (fromOwner) {
      log.debug(`Канал A ${chatId}: пишет владелец — бот молчит`);
      if (msg.text) {
        try {
          const lastInMsg = await db.select().from(messages)
            .where(and(eq(messages.chatId, chatId), eq(messages.direction, 'in')))
            .orderBy(desc(messages.createdAt))
            .limit(1);

          if (lastInMsg[0]?.text) {
            recordManagerFeedback({
              chatId,
              clientText: lastInMsg[0].text,
              managerActualText: msg.text,
            });
          }
        } catch (e) {
          log.warn('Ошибка фиксации обратной связи менеджера', (e as Error).message);
        }
      }
      return;
    }

    const botOn = await isBotEnabled();
    if (!botOn) {
      log.info(`Канал A ${chatId}: бот выключен через админку — пропускаем сообщение`);
      return;
    }

    const gate = businessChatAllowed(chatId);
    if (!gate.ok) {
      log.info(`Канал A ${chatId}: пропуск — ${gate.why}`);
      return;
    }

    log.info(`Канал A ${chatId} · ${ctx.from?.first_name ?? '?'}: ${msg.text ?? '[вложение]'}`);

    if (ctx.from) {
      const [cust] = await db.insert(customers).values({
        tgUserId: ctx.from.id,
        firstName: ctx.from.first_name ?? null,
        username: ctx.from.username ?? null,
      }).onConflictDoUpdate({
        target: customers.tgUserId,
        set: { firstName: ctx.from.first_name ?? null, username: ctx.from.username ?? null },
      }).returning();

      if (cust) {
        await db.insert(channelBindings).values({
          customerId: cust.id,
          channel: 'A',
          chatId,
          businessConnectionId: connId ?? null,
          lastSeenAt: new Date(),
        }).onConflictDoUpdate({
          target: [channelBindings.channel, channelBindings.chatId],
          set: { lastSeenAt: new Date(), businessConnectionId: connId ?? null },
        });
      }
    }

    let text = msg.text ?? msg.caption ?? '';
    const kind = describeNonText(msg);

    if (kind === 'sticker') return;

    let attachmentKind = kind ? (KIND_RU[kind] ?? kind) : undefined;
    const rawMsg = msg as Record<string, any>;

    if (kind === 'voice' || kind === 'audio') {
      const audioId = rawMsg.voice?.file_id ?? rawMsg.audio?.file_id;
      const audioMime = rawMsg.voice?.mime_type ?? rawMsg.audio?.mime_type ?? 'audio/ogg';
      if (audioId) {
        try {
          const { buffer } = await downloadTelegramFile(ctx.api, audioId);
          const transcript = await transcribeAudio(buffer, audioMime);
          if (transcript) {
            log.info(`Канал A ${chatId}: голосовое расшифровано -> «${transcript}»`);
            text = transcript;
            attachmentKind = 'голосовое (расшифровано)';
          }
        } catch (e) {
          log.warn(`Канал A ${chatId}: не удалось расшифровать аудио: ${(e as Error).message}`);
        }
      }
    }

    let attachmentFileId: string | undefined;
    let attachmentMimeType: string | undefined;
    if (kind === 'document') {
      attachmentFileId = rawMsg.document?.file_id;
      attachmentMimeType = rawMsg.document?.mime_type ?? 'application/pdf';
    } else if (kind === 'photo') {
      attachmentFileId = rawMsg.photo?.at(-1)?.file_id;
      attachmentMimeType = 'image/jpeg';
      if (attachmentFileId) {
        try {
          const { buffer } = await downloadTelegramFile(ctx.api, attachmentFileId);
          const photoOrder = await extractOrderFromPhoto(buffer, 'image/jpeg');
          if (photoOrder && photoOrder.isOrder) {
            log.info(`Канал A ${chatId}: распознан заказ с фото -> «${photoOrder.rawSummary}»`);
            text = `[Заказ с фото]: ${photoOrder.rawSummary}` + (text ? `\nКомментарий: ${text}` : '');
            attachmentKind = 'фото заказа (распознано)';
          }
        } catch (e) {
          log.warn(`Канал A ${chatId}: ошибка распознавания фото: ${(e as Error).message}`);
        }
      }
    }

    const currentMode = await getActiveMode();
    const isAssistMode = currentMode === 'assist';
    const canSendToClientsDynamic = currentMode === 'live';

    if (isAssistMode) {
      await handleIncoming(ctx.api, {
        chatId, messageId: msg.message_id,
        businessConnectionId: connId,
        clientName: ctx.from?.first_name ?? 'клиент',
        username: ctx.from?.username,
        text,
        attachmentKind,
        attachmentFileId,
        attachmentMimeType,
      });
      return;
    }

    if (!text && kind) {
      log.info(`Канал A ${chatId}: прислали ${kind} — передаю менеджеру`);

      if (canSendToClientsDynamic) {
        await send(ctx.api, {
          dedupeKey: `ack:${chatId}:${msg.message_id}`,
          kind: 'a_channel_ack',
          chatId,
          text: ACK_BY_KIND[kind] ?? 'Получили, передаю коллегам.',
          audience: 'client',
          channel: 'A',
          businessConnectionId: connId,
        });
      }

      if (config.MANAGER_CHAT_ID) {
        await send(ctx.api, {
          dedupeKey: `draft:${chatId}:${msg.message_id}`,
          kind: 'a_channel_draft',
          chatId: config.MANAGER_CHAT_ID,
          text: [
            '<b>Канал A · нужен менеджер</b>',
            `От: ${esc(ctx.from?.first_name ?? '?')}`
              + (ctx.from?.username ? ` @${esc(ctx.from.username)}` : ''),
            '',
            `Прислали: <b>${KIND_RU[kind] ?? kind}</b>`,
            '',
            '<i>Бот файлы не разбирает — это работа человека.</i>',
          ].join('\n'),
          audience: 'staff',
          channel: 'B',
        });
      }
      return;
    }

    if (!text) return;

    const cust = ctx.from
      ? (await db.select().from(customers).where(eq(customers.tgUserId, ctx.from.id)).limit(1))[0]
      : undefined;
    const marketId = cust?.marketIds?.[0] ?? null;
    const market = marketId != null
      ? (await db.select().from(markets).where(eq(markets.id, marketId)).limit(1))[0]
      : undefined;

    const prev = await db.select().from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.id))
      .limit(11);

    const history = prev.reverse().slice(0, -1)
      .filter((m) => m.text)
      .map((m) => ({
        role: (m.author === 'client' ? 'user' : 'model') as 'user' | 'model',
        text: m.text!,
      }));

    const turn = await runAgent({
      message: text,
      channel: 'A',
      ctx: { marketId },
      clientName: ctx.from?.first_name ?? null,
      marketName: market?.name ?? null,
      history,
    });

    if (turn.error) log.error('Агент не смог ответить', turn.error);

    if (canSendToClientsDynamic && turn.reply && !turn.error) {
      const res = await send(ctx.api, {
        dedupeKey: `reply:${chatId}:${msg.message_id}`,
        kind: 'a_channel_reply',
        chatId,
        text: turn.reply,
        audience: 'client',
        channel: 'A',
        businessConnectionId: connId,
      });

      if (res.sent) {
        await db.insert(messages).values({
          customerId: cust?.id ?? null,
          channel: 'A', chatId,
          tgMessageId: res.messageId,
          direction: 'out', author: 'bot',
          text: turn.reply,
          toolCalls: turn.toolCalls,
          mode: config.MODE,
        });

        if (turn.attachments.length) {
          const sent = await sendAttachments(ctx.api, chatId, turn.attachments, connId);
          const failed = sent.filter((r) => !r.ok);
          if (failed.length) {
            log.error('Часть файлов не ушла', failed.map((f) => `${f.key}: ${f.error}`).join('; '));
          }
        }
      }
    }

    const needStaff = !canSendToClients || turn.handoff || turn.error;
    if (config.MANAGER_CHAT_ID && needStaff) {
      const tools = turn.toolCalls.map((t) => t.name).join(', ');
      await send(ctx.api, {
        dedupeKey: `draft:${chatId}:${msg.message_id}`,
        kind: 'a_channel_draft',
        chatId: config.MANAGER_CHAT_ID,
        text: [
          turn.handoff
            ? `<b>Канал A · нужен менеджер</b>`
            : `<b>Канал A · новое сообщение</b>`,
          `От: ${esc(ctx.from?.first_name ?? '?')}`
            + (ctx.from?.username ? ` @${esc(ctx.from.username)}` : '')
            + (market ? ` · ${esc(market.name)}` : ' · точка не определена'),
          '',
          `Клиент: ${esc(text)}`,
          '',
          turn.error
            ? `<i>Ошибка: ${esc(turn.error)}</i>`
            : `Ответ бота: ${esc(turn.reply || '(промолчал)')}`,
          turn.handoff ? `\n⚠️ <b>Причина передачи:</b> ${esc(turn.handoff)}` : '',
          tools ? `\n<i>инструменты: ${esc(tools)}</i>` : '',
          canSendToClients ? '' : `\n<i>Режим «только слушаю» — клиенту не отвечено.</i>`,
        ].filter(Boolean).join('\n'),
        audience: 'staff',
        channel: 'B',
      });
    }
  });

  bot.command('start', async (ctx) => {
    const payload = ctx.match;
    log.info(`Канал B: /start от ${ctx.from?.id}${payload ? ` (${payload})` : ''}`);

    if (ctx.chat.type !== 'private') {
      await ctx.reply('Бот на месте. Напишите /chatid, чтобы получить ID этой группы.');
      return;
    }

    const s = await getAllSettings();
    const brand = s.company_brand || s.company_name || 'AKM Holdings';

    await ctx.reply(
      isAssist
        ? `Здравствуйте! Это ${brand}.\n\n`
          + 'Напишите, что вас интересует: наличие товара, цены, заказ. '
          + 'Можно прислать фото или документ.\n\n'
          + 'Вам ответит наш сотрудник.'
        : `Здравствуйте! Это официальный бот ${brand}.\n\n`
          + 'Пока идёт настройка — доступна проверка связи.\n'
          + 'Если вы сотрудник, добавьте бота в группу и напишите /chatid.',
    );
  });

  bot.command('chatid', async (ctx) => {
    const c = ctx.chat;
    log.info(`/chatid в чате ${c.id} (${c.type})`);
    await ctx.reply(
      `<b>ID этого чата:</b> <code>${c.id}</code>\n`
      + `Тип: ${c.type}\n\n`
      + `Впишите его в .env:\n`
      + `<code>ACCOUNTANT_CHAT_ID=${c.id}</code>`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('status', async (ctx) => {
    const db = await getDb();
    const s = await getAllSettings();
    const brand = s.company_brand || s.company_name || 'AKM Holdings';

    const [q] = await db
      .select({
        total: sql<number>`count(*)::int`,
        issued: sql<number>`count(*) filter (where ${esfQueue.status} = 'issued')::int`,
        posted: sql<number>`count(*) filter (where ${esfQueue.status} = 'posted')::int`,
      })
      .from(esfQueue);

    const [conn] = await db.select().from(businessConnections)
      .orderBy(desc(businessConnections.updatedAt)).limit(1);

    const debts = await calculateDebts();
    const dormant = await findDormantMarkets();

    await ctx.reply(
      `<b>Состояние системы ${brand}</b>\n\n`
      + `Режим: <b>${config.MODE}</b>\n`
      + `Канал A: ${conn ? (conn.isEnabled ? `подключён @${conn.ownerUsername ?? conn.ownerUserId}` : 'отключён') : 'не подключён'}\n\n`
      + `📑 <b>ЭСФ (M1):</b> всего ${q?.total ?? 0} · выставлено: ${q?.issued ?? 0} · в работе: ${q?.posted ?? 0}\n`
      + `💰 <b>Дебиторка (M5):</b> ${fmtSum(debts.totalDebt)} (просрочено: ${fmtSum(debts.totalOverdue)}, должников: ${debts.debtorsCount})\n`
      + `💤 <b>Спящие точки (M4):</b> ${dormant.length} клиентов требуют реактивации\n\n`
      + `<i>Команды: /debts, /reactivate, /esf, /digest</i>`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('esf', async (ctx) => {
    const n = await postNewOrders(ctx.api);
    const p = await postNewPayments(ctx.api);
    await ctx.reply(`Опубликовано карточек: ${n}, перечислений: ${p}`);
  });

  bot.command('digest', async (ctx) => {
    await postDailyDigest(ctx.api);
    await ctx.reply('Сводка отправлена.');
  });

  bot.command(['debts', 'debt', 'dolgi'], async (ctx) => {
    await postDebtSummary(ctx.api, ctx.chat.id);
  });

  bot.command(['reactivate', 'sleeping', 'crm'], async (ctx) => {
    const count = await postReactivationCards(ctx.api, ctx.chat.id);
    if (count === 0) {
      await ctx.reply('Спящих клиентов с нарушением привычного цикла заказа сейчас не найдено.');
    }
  });

  bot.callbackQuery(/^esf:/, async (ctx) => {
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
      || ctx.from.username || String(ctx.from.id);

    const res = await handleEsfCallback(ctx.api, ctx.callbackQuery.data, ctx.from.id, name);

    await ctx.answerCallbackQuery({
      text: res.answer.slice(0, 200),
      show_alert: res.alert ?? false,
    });

    if (res.edit) {
      await ctx.editMessageText(res.edit, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  bot.callbackQuery(/^debt:/, async (ctx) => {
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
      || ctx.from.username || String(ctx.from.id);

    const res = await handleDebtCallback(ctx.api, ctx.callbackQuery.data, ctx.from.id, name);
    await ctx.answerCallbackQuery({ text: res.answer.slice(0, 200), show_alert: res.alert ?? false });

    if (res.edit) {
      await ctx.editMessageText(res.edit, {
        parse_mode: 'HTML',
        reply_markup: res.keyboard,
      }).catch(() => {});
    }
  });

  bot.callbackQuery(/^m4:/, async (ctx) => {
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
      || ctx.from.username || String(ctx.from.id);

    const res = await handleReactivationCallback(ctx.api, ctx.callbackQuery.data, ctx.from.id, name);
    await ctx.answerCallbackQuery({ text: res.answer.slice(0, 200), show_alert: res.alert ?? false });

    if (res.edit) {
      await ctx.editMessageText(res.edit, {
        parse_mode: 'HTML',
        reply_markup: res.keyboard,
      }).catch(() => {});
    }
  });

  bot.callbackQuery(/^req:/, async (ctx) => {
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
      || ctx.from.username || String(ctx.from.id);

    const res = await handleAssistCallback(ctx.api, ctx.callbackQuery.data, ctx.from.id, name);
    await ctx.answerCallbackQuery({ text: res.answer.slice(0, 200), show_alert: res.alert ?? false });

    if (res.edit) {
      await ctx.editMessageText(res.edit, {
        parse_mode: 'HTML',
        reply_markup: res.keyboard,
      }).catch(() => {});
    }
  });

  bot.on('message:text', async (ctx, next) => {
    const reply = ctx.message.reply_to_message;
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

    if (!isGroup || !reply || reply.from?.id !== ctx.me.id) return next();
    if (ctx.message.text.startsWith('/')) return next();

    const staff = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
      || ctx.from.username || String(ctx.from.id);

    const res = await relayStaffReply(ctx.api, reply.message_id, ctx.message.text, staff);

    if (!res.ok && res.notACard) return next();

    await ctx.reply(res.ok ? `✅ ${res.note}` : `⚠️ ${res.note}`, {
      reply_parameters: { message_id: ctx.message.message_id },
    });
  });

  bot.on('message', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();

    const botOn = await isBotEnabled();
    if (!botOn) {
      if (!ctx.message.text?.startsWith('/')) {
        await ctx.reply('Бот временно отключен на техническое обслуживание.');
      }
      return;
    }

    const currentMode = await getActiveMode();
    const isAssistMode = currentMode === 'assist';
    if (!isAssistMode) return next();

    const msg = ctx.message;
    if (msg.text?.startsWith('/')) return next();

    const kind = describeNonText(msg);
    if (kind === 'sticker') return;
    if (kind === 'contact') return next();

    let text = msg.text ?? msg.caption ?? '';
    if (!text && !kind) return next();

    let attachmentKind = kind ? (KIND_RU[kind] ?? kind) : undefined;
    const rawMsg = msg as Record<string, any>;

    if (kind === 'voice' || kind === 'audio') {
      const audioId = rawMsg.voice?.file_id ?? rawMsg.audio?.file_id;
      const audioMime = rawMsg.voice?.mime_type ?? rawMsg.audio?.mime_type ?? 'audio/ogg';
      if (audioId) {
        try {
          const { buffer } = await downloadTelegramFile(ctx.api, audioId);
          const transcript = await transcribeAudio(buffer, audioMime);
          if (transcript) {
            log.info(`Канал B ${ctx.chat.id}: голосовое расшифровано -> «${transcript}»`);
            text = transcript;
            attachmentKind = 'голосовое (расшифровано)';
          }
        } catch (e) {
          log.warn(`Канал B ${ctx.chat.id}: не удалось расшифровать аудио: ${(e as Error).message}`);
        }
      }
    }

    let attachmentFileId: string | undefined;
    let attachmentMimeType: string | undefined;
    if (kind === 'document') {
      attachmentFileId = rawMsg.document?.file_id;
      attachmentMimeType = rawMsg.document?.mime_type ?? 'application/pdf';
    } else if (kind === 'photo') {
      attachmentFileId = rawMsg.photo?.at(-1)?.file_id;
      attachmentMimeType = 'image/jpeg';
    }

    const db = await getDb();

    await db.insert(customers).values({
      tgUserId: ctx.from.id,
      firstName: ctx.from.first_name ?? null,
      username: ctx.from.username ?? null,
    }).onConflictDoUpdate({
      target: customers.tgUserId,
      set: { firstName: ctx.from.first_name ?? null, username: ctx.from.username ?? null },
    });

    await db.insert(messages).values({
      channel: 'B',
      chatId: ctx.chat.id,
      tgMessageId: msg.message_id,
      direction: 'in',
      author: 'client',
      text: text || `[${KIND_RU[kind ?? 'other'] ?? 'вложение'}]`,
      mode: config.MODE,
    });

    log.info(`Канал B ${ctx.chat.id} · ${ctx.from.first_name ?? '?'}: ${text || `[${kind}]`}`);

    await handleIncoming(ctx.api, {
      chatId: ctx.chat.id,
      messageId: msg.message_id,
      clientName: ctx.from.first_name ?? 'клиент',
      username: ctx.from.username,
      text,
      attachmentKind,
      attachmentFileId,
      attachmentMimeType,
    });
  });

  bot.on('message:contact', async (ctx) => {
    const phone = normalizePhone(ctx.message.contact.phone_number);
    if (!phone.ok) {
      await ctx.reply(`Не разобрал номер: ${phone.reason}. Передам менеджеру.`);
      return;
    }
    await ctx.reply(`Спасибо. Номер ${phone.e164} записан — ищу вашу точку в системе.`);
    log.info(`Канал B: контакт ${phone.e164} от ${ctx.from.id}`);
  });

  bot.catch((err) => {
    log.error('Ошибка в обработчике бота', err.message);
  });

  return bot;
}
