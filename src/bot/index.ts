import { Bot, InlineKeyboard } from 'grammy';
import { eq, sql, desc } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { businessConnections, customers, channelBindings, messages, esfQueue, orders } from '../db/schema.js';
import { log } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { send, businessChatAllowed } from './send.js';
import { handleEsfCallback, postNewOrders, postNewPayments, postDailyDigest } from './esf.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function createBot(): Bot {
  const bot = new Bot(config.BOT_TOKEN);

  /* Трассировка входящих: без неё непонятно, доходят ли обновления вообще */
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

  /* Бота добавили в группу или убрали — сразу показываем ID чата */
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

  /* ─────────── Канал A: подключение к аккаунту ─────────── */

  bot.on('business_connection', async (ctx) => {
    const c = ctx.businessConnection;
    const db = await getDb();

    // В разных версиях Bot API права приходят либо флагом can_reply,
    // либо объектом rights — поддерживаем оба варианта.
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

  /* ─────────── Канал A: сообщения клиентов ─────────── */

  bot.on('business_message', async (ctx) => {
    const msg = ctx.businessMessage;
    const connId = msg.business_connection_id;
    const chatId = msg.chat.id;
    const db = await getDb();

    const conn = connId
      ? (await db.select().from(businessConnections).where(eq(businessConnections.id, connId)).limit(1))[0]
      : undefined;

    // Сообщение владельца аккаунта — человек вступил в разговор.
    // Наше дело здесь только записать: бот в этот диалог не лезет.
    const fromOwner = conn && ctx.from?.id === conn.ownerUserId;

    await db.insert(messages).values({
      channel: 'A',
      chatId,
      tgMessageId: msg.message_id,
      direction: fromOwner ? 'out' : 'in',
      author: fromOwner ? 'human' : 'client',
      text: msg.text ?? msg.caption ?? '[без текста]',
      mode: config.MODE,
    });

    if (fromOwner) {
      log.debug(`Канал A ${chatId}: пишет владелец — бот молчит`);
      return;
    }

    const gate = businessChatAllowed(chatId);
    if (!gate.ok) {
      log.info(`Канал A ${chatId}: пропуск — ${gate.why}`);
      return;
    }

    log.info(`Канал A ${chatId} · ${ctx.from?.first_name ?? '?'}: ${msg.text ?? '[вложение]'}`);

    // Запоминаем клиента и его чат в канале A
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

    // M3 (диалог с ИИ) ещё не подключён. Пока — режим «только слушаю»
    // из недели 4: черновик ответа уходит менеджерам, клиенту ничего.
    if (config.MANAGER_CHAT_ID) {
      await send(ctx.api, {
        dedupeKey: `draft:${chatId}:${msg.message_id}`,
        kind: 'a_channel_draft',
        chatId: config.MANAGER_CHAT_ID,
        text: [
          `<b>Канал A · новое сообщение</b>`,
          `От: ${esc(ctx.from?.first_name ?? '?')}`
            + (ctx.from?.username ? ` @${esc(ctx.from.username)}` : ''),
          '',
          esc(msg.text ?? '[вложение]'),
          '',
          `<i>Бот в режиме «только слушаю» — клиенту не отвечено.</i>`,
        ].join('\n'),
        audience: 'staff',
        channel: 'B',
      });
    }
  });

  /* ─────────── Канал B: команды ─────────── */

  bot.command('start', async (ctx) => {
    const payload = ctx.match;
    log.info(`Канал B: /start от ${ctx.from?.id}${payload ? ` (${payload})` : ''}`);

    await ctx.reply(
      'Здравствуйте! Это бот AKM Holdings.\n\n'
      + 'Пока идёт настройка — доступна проверка связи.\n'
      + 'Если вы сотрудник, добавьте бота в рабочую группу и напишите /chatid.',
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
    const [q] = await db
      .select({
        total: sql<number>`count(*)::int`,
        issued: sql<number>`count(*) filter (where ${esfQueue.status} = 'issued')::int`,
        posted: sql<number>`count(*) filter (where ${esfQueue.status} = 'posted')::int`,
      })
      .from(esfQueue);

    const [conn] = await db.select().from(businessConnections)
      .orderBy(desc(businessConnections.updatedAt)).limit(1);

    await ctx.reply(
      `<b>Состояние бота</b>\n\n`
      + `Режим: <b>${config.MODE}</b>\n`
      + `Канал A: ${conn ? (conn.isEnabled ? `подключён @${conn.ownerUsername ?? conn.ownerUserId}` : 'отключён') : 'не подключён'}\n`
      + `ЭСФ всего: ${q?.total ?? 0} · выставлено: ${q?.issued ?? 0} · в работе: ${q?.posted ?? 0}`,
      { parse_mode: 'HTML' },
    );
  });

  /** Ручная публикация карточек — удобно на тесте */
  bot.command('esf', async (ctx) => {
    const n = await postNewOrders(ctx.api);
    const p = await postNewPayments(ctx.api);
    await ctx.reply(`Опубликовано карточек: ${n}, перечислений: ${p}`);
  });

  bot.command('digest', async (ctx) => {
    await postDailyDigest(ctx.api);
    await ctx.reply('Сводка отправлена.');
  });

  /* ─────────── Кнопки ЭСФ ─────────── */

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

  /* ─────────── Канал B: контакт для привязки ─────────── */

  bot.on('message:contact', async (ctx) => {
    const phone = normalizePhone(ctx.message.contact.phone_number);
    if (!phone.ok) {
      await ctx.reply(`Не разобрал номер: ${phone.reason}. Передам менеджеру.`);
      return;
    }
    await ctx.reply(`Спасибо. Номер ${phone.e164} записан — ищу вашу точку в системе.`);
    log.info(`Канал B: контакт ${phone.e164} от ${ctx.from.id}`);
  });

  /* ─────────── Ошибки ─────────── */

  bot.catch((err) => {
    log.error('Ошибка в обработчике бота', err.message);
  });

  return bot;
}
