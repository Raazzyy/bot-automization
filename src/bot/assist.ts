import type { Api } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import { eq, desc, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { requests, messages, customers, mediaFiles, orders, orderItems, markets, payments } from '../db/schema.js';
import { extractRequest, type Extracted } from '../ai/extract.js';
import { detectLang } from '../ai/prompt.js';
import { runAgent } from '../ai/agent.js';
import { downloadTelegramFile, extractRequisitesFromMedia, type CompanyRequisites } from '../ai/media-ai.js';
import { sendAttachments } from './media.js';
import { send } from './send.js';
import { log } from '../lib/logger.js';
import { fmtAmount, fmtSum, todayTashkent } from '../lib/money.js';
import { generateWaybillPdf, generateReconciliationPdf } from '../lib/pdf-waybill.js';
import { matchOrderEntitiesToCatalog, type EnrichedEntity } from '../ai/catalog-match.js';
import { getCompanyProfile } from '../lib/settings.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const STATUS_LABEL: Record<string, string> = {
  new: '🔴 новое',
  in_work: '🟡 в работе',
  done: '🟢 готово',
};

export type ExtractedWithAuto = Extracted & {
  autoActions?: string[];
  requisites?: CompanyRequisites | null;
  matchedOrders?: EnrichedEntity[] | null;
};

export interface IncomingRequest {
  chatId: number;
  messageId: number;
  businessConnectionId?: string;
  clientName: string;
  username?: string;
  text: string;
  attachmentKind?: string;
  attachmentFileId?: string;
  attachmentMimeType?: string;
}

export async function matchMediaFiles(text: string): Promise<typeof mediaFiles.$inferSelect[]> {
  if (!text.trim()) return [];
  const db = await getDb();
  const allMedia = await db.select().from(mediaFiles).where(eq(mediaFiles.isActive, true));
  const norm = text.toLowerCase();

  const matched: typeof mediaFiles.$inferSelect[] = [];
  for (const m of allMedia) {
    const keywords = m.keywords ?? [];
    let hit = false;
    for (const kw of keywords) {
      const k = kw.toLowerCase().trim();
      if (!k) continue;
      if (k.includes(' ') || k.includes('-')) {
        if (norm.includes(k)) {
          hit = true;
          break;
        }
      } else {
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${k}([^\\p{L}\\p{N}]|$)`, 'u');
        if (re.test(norm)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) matched.push(m);
  }
  return matched;
}

function renderCard(r: {
  id: number;
  clientName: string;
  username: string | null;
  text: string;
  status: string;
  takenByName: string | null;
  extracted: ExtractedWithAuto | null;
  attachmentKind: string | null;
}): string {
  const x = r.extracted;
  const lines: string[] = [];

  const head = x?.isOrder ? '🛒 Заказ' : (x?.aboutDocuments || x?.requisites) ? '📄 Документы' : '💬 Обращение';
  lines.push(`<b>${head} №${r.id}</b>  ${STATUS_LABEL[r.status] ?? r.status}`);
  lines.push('');
  lines.push(`От: <b>${esc(r.clientName)}</b>${r.username ? ` @${esc(r.username)}` : ''}`);

  if (r.attachmentKind) {
    lines.push(`Прислал: <b>${esc(r.attachmentKind)}</b>`);
  }

  lines.push('');
  lines.push(`<i>${esc(r.text).slice(0, 900)}</i>`);

  if (x?.matchedOrders?.length) {
    lines.push('');
    for (const o of x.matchedOrders) {
      if (o.entity) lines.push(`<b>${esc(o.entity)}</b>`);
      for (const it of o.items) {
        const rawQty = it.qty != null ? ` — ${fmtAmount(it.qty)}${it.rawUnit ? ' ' + esc(it.rawUnit) : ''}` : '';
        lines.push(`  • ${esc(it.rawName)}${rawQty}`);
        if (it.isMatched) {
          const matchIcon = it.confidence === 'exact' ? '🎯' : '🔎';
          lines.push(`    ↳ ${matchIcon} <i>Каталог:</i> <b>${esc(it.officialName)}</b> · <b>${fmtSum(it.price)}</b> / ${esc(it.unit)}${it.stock > 0 ? ` (остаток: ${fmtAmount(it.stock)})` : ''}`);
        }
      }
      if (o.totalSum > 0) {
        lines.push(`  💰 <i>Итого по каталогу:</i> <b>${fmtSum(o.totalSum)} сум</b>`);
      }
    }
  } else if (x?.orders?.length) {
    lines.push('');
    for (const o of x.orders) {
      if (o.entity) lines.push(`<b>${esc(o.entity)}</b>`);
      for (const it of o.items) {
        const qty = it.qty != null ? ` — ${fmtAmount(it.qty)}${it.unit ? ' ' + esc(it.unit) : ''}` : '';
        lines.push(`  • ${esc(it.name)}${qty}`);
      }
    }
  }

  if (x?.requisites) {
    const q = x.requisites;
    if (q.inn || q.companyName || q.director || q.passportNumber || q.pinfl || q.account) {
      lines.push('');
      const docLabel = q.documentType ? ` (${esc(q.documentType.replace(/_/g, ' '))})` : '';
      lines.push(`📋 <b>Данные из документа${docLabel}:</b>`);
      if (q.companyName) lines.push(`  • Организация: <b>${esc(q.companyName)}</b>`);
      if (q.inn) lines.push(`  • ИНН: <code>${esc(q.inn)}</code>`);
      if (q.account) lines.push(`  • Р/С: <code>${esc(q.account)}</code>`);
      if (q.bankName || q.mfo) lines.push(`  • Банк: ${esc(q.bankName ?? '')}${q.mfo ? ` (МФО ${esc(q.mfo)})` : ''}`);
      if (q.director) lines.push(`  • ФИО / Директор: <b>${esc(q.director)}</b>`);
      if (q.pinfl) lines.push(`  • ПИНФЛ: <code>${esc(q.pinfl)}</code>`);
      if (q.passportNumber) lines.push(`  • Паспорт / ID: <code>${esc(q.passportNumber)}</code>`);
      if (q.address) lines.push(`  • Адрес: ${esc(q.address)}`);
    }
  }

  if (x?.questions?.length) {
    lines.push('');
    lines.push('<b>Вопросы:</b>');
    for (const q of x.questions) lines.push(`  — ${esc(q)}`);
  }

  if (x?.autoActions?.length) {
    lines.push('');
    lines.push('<b>Автоматика:</b>');
    for (const a of x.autoActions) lines.push(`  ✅ ${esc(a)}`);
  }

  if (r.takenByName) {
    lines.push('');
    lines.push(`Взял: <b>${esc(r.takenByName)}</b>`);
  }

  lines.push('');
  if (r.status === 'done') {
    lines.push('<i>Обращение выполнено. Если нужно написать клиенту — ответьте на это сообщение.</i>');
  } else {
    lines.push('<i>Ответьте текстом или нажмите кнопку быстрого ответа:</i>');
  }

  return lines.join('\n');
}

function cardKeyboard(id: number, status: string, extracted?: ExtractedWithAuto | null): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (status !== 'done') {
    if (extracted?.isOrder) {
      kb.text('🚚 Завтра к 11:00', `req:quick:${id}:tomorrow_11`)
        .text('🚚 Сегодня до 18:00', `req:quick:${id}:today_18`);
      kb.row()
        .text('📦 На сборке', `req:quick:${id}:warehouse`)
        .text('📄 Накладная PDF', `req:pdf:${id}`);
      kb.row()
        .text('Готово', `req:done:${id}`);
    } else if (extracted?.aboutDocuments || extracted?.requisites) {
      kb.text('📄 Договор готовим', `req:quick:${id}:doc_preparing`)
        .text('✅ Реквизиты приняты', `req:quick:${id}:doc_ok`);
      kb.row()
        .text(status === 'new' ? 'Взять в работу' : 'В работе', `req:take:${id}`)
        .text('Готово', `req:done:${id}`);
    } else {
      if (status === 'new') kb.text('Взять в работу', `req:take:${id}`);
      kb.text('Готово', `req:done:${id}`);
    }
  }

  const addr = extracted?.requisites?.address;
  if (addr) {
    kb.row().url('📍 Маршрут (Яндекс Карты)', `https://yandex.uz/maps/?text=${encodeURIComponent(addr)}`);
  }

  kb.row().text('Показать клиента', `req:who:${id}`);
  return kb;
}

export function extractMarketNameFromText(text: string): string | null {
  if (!text) return null;

  const quoted = text.match(/[«"']([^»"']{2,40})[»"']/);
  if (quoted && quoted[1]) {
    const q = quoted[1].trim();
    if (q.length > 1 && !/^(накладная|акт|сверка|заказ|чек|price|каталог)/i.test(q)) {
      return q;
    }
  }

  const match = text.match(/(?:ресторан[уае]?|restoran(?:ga|da|i)?|кафе|kafe|магазин[уае]?|do['`‘ʼ]?kon|dokon|ошхона|oshxona|чойхона|choyxona|ооо|мчж|mchj)\s*([a-zA-Zа-яА-ЯёЁ0-9_-]+(?:\s+[a-zA-Zа-яА-ЯёЁ0-9_-]+)?)/i);
  if (match && match[1]) {
    const raw = match[1].trim();
    if (!/^(на|для|по|в|va|uchun|bilan|ga|da|ni)$/i.test(raw)) {
      return raw;
    }
  }

  return null;
}

export async function handleIncoming(api: Api, r: IncomingRequest): Promise<void> {
  const chat = config.ASSIST_CHAT_ID || config.MANAGER_CHAT_ID;
  if (!chat) {
    log.warn('Полуавтомат: не задан ASSIST_CHAT_ID — карточку некуда отправлять');
    return;
  }

  const db = await getDb();
  const autoActions: string[] = [];
  let status = 'new';

  const matchedFiles = await matchMediaFiles(r.text);

  if (matchedFiles.length > 0) {
    const lang = detectLang(r.text);
    const intro = lang === 'uz'
      ? 'Assalomu alaykum! Kompaniyamizning amaldagi materiallarini yuborayapman:'
      : 'Здравствуйте! Отправляю актуальные материалы компании:';

    try {
      const sentIntro = await api.sendMessage(r.chatId, intro, {
        ...(r.businessConnectionId ? { business_connection_id: r.businessConnectionId } : {}),
      });

      await db.insert(messages).values({
        channel: 'A',
        chatId: r.chatId,
        tgMessageId: sentIntro.message_id,
        direction: 'out',
        author: 'bot',
        text: intro,
        mode: config.MODE,
      });

      const keys = matchedFiles.map((m) => m.key);
      const sentMedia = await sendAttachments(api, r.chatId, keys, r.businessConnectionId);
      const okFiles = matchedFiles.filter((m) => sentMedia.find((s) => s.key === m.key && s.ok));

      for (const m of okFiles) {
        await db.insert(messages).values({
          channel: 'A',
          chatId: r.chatId,
          direction: 'out',
          author: 'bot',
          text: `[файл: ${m.title}]`,
          mode: config.MODE,
        });
      }

      if (okFiles.length > 0) {
        autoActions.push(`Отправил клиенту: ${okFiles.map((f) => f.title).join(', ')}`);
      }
    } catch (e) {
      log.error('Не удалось автоматически отправить файлы клиенту', (e as Error).message);
    }
  }

  let matchedOrders: EnrichedEntity[] | null = null;

  const extracted = r.text ? await extractRequest(r.text) : null;

  if (matchedFiles.length > 0) {
    const otherQuestions = extracted?.questions?.filter(
      (q) => !/(прайс|каталог|katalog|price|narx|файл|скин)/i.test(q)
    ) ?? [];
    if (!extracted?.isOrder && !extracted?.aboutDocuments && otherQuestions.length === 0) {
      status = 'done';
    }
  }

  let requisites: CompanyRequisites | null = null;
  const isWaybillRequest = /(накладн|накл|чек|hisob.faktura|nakladnoy)/i.test(r.text);
  const isActRequest = /(акт сверк|сверк|akt sverk|hisob.kitob)/i.test(r.text);

  const isCustomerSubmittingDocs = Boolean(
    r.attachmentKind ||
    (extracted?.aboutDocuments && !isWaybillRequest && !isActRequest) ||
    (/(реквизит|договор|инн|выписк|rekvizit|shartnoma|guvohnoma|hujjat)/i.test(r.text) && !isWaybillRequest && !isActRequest)
  );

  if (r.attachmentFileId && r.attachmentMimeType && isCustomerSubmittingDocs) {
    try {
      const { buffer } = await downloadTelegramFile(api, r.attachmentFileId);
      requisites = await extractRequisitesFromMedia(buffer, r.attachmentMimeType);
      if (requisites) {
        const title = requisites.companyName || requisites.director || requisites.documentType || 'документ';
        const docId = requisites.inn ? ` (ИНН: ${requisites.inn})` : (requisites.pinfl ? ` (ПИНФЛ: ${requisites.pinfl})` : '');
        autoActions.push(`Извлечены данные: ${title}${docId}`);
      }
    } catch (e) {
      log.warn('OCR реквизитов не удался', (e as Error).message);
    }
  }

  if (isCustomerSubmittingDocs && !matchedFiles.length) {
    const lang = detectLang(r.text);
    const ackText = lang === 'uz'
      ? 'Hujjatlar va rekvizitlar qabul qilindi, rahmat! Menejerimiz shartnomani tayyorlab, siz bilan bog‘lanadi.'
      : 'Реквизиты и документы получили, спасибо! Менеджер подготовит договор и свяжется с вами.';

    try {
      const sentAck = await api.sendMessage(r.chatId, ackText, {
        ...(r.businessConnectionId ? { business_connection_id: r.businessConnectionId } : {}),
      });

      await db.insert(messages).values({
        channel: 'A',
        chatId: r.chatId,
        tgMessageId: sentAck.message_id,
        direction: 'out',
        author: 'bot',
        text: ackText,
        mode: config.MODE,
      });

      autoActions.push('Подтвердил получение документов и реквизитов (передал менеджеру)');
    } catch (e) {
      log.error('Не удалось отправить подтверждение документов', (e as Error).message);
    }
  }

  const isRepeatRequest = /(повтор|как в прошлый|o'tgan safar|o‘tgan safar|takror)/i.test(r.text);
  if (isRepeatRequest && !extracted?.isOrder) {
    const cust = (await db.select().from(customers).where(eq(customers.tgUserId, r.chatId)).limit(1))[0];
    const marketIds = cust?.marketIds ?? [];

    let lastOrder = null;
    if (marketIds.length > 0) {
      lastOrder = (await db.select().from(orders)
        .where(inArray(orders.marketId, marketIds))
        .orderBy(desc(orders.id))
        .limit(1))[0];
    }
    if (!lastOrder) {
      lastOrder = (await db.select().from(orders).orderBy(desc(orders.id)).limit(1))[0];
    }

    if (lastOrder) {
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, lastOrder.id));
      if (items.length) {
        const lang = detectLang(r.text);
        const lines: string[] = [];
        if (lang === 'uz') {
          lines.push(`«${lastOrder.marketName ?? 'Sizning nuqtangiz'}» uchun o‘tgan safar quyidagilarni buyurtma qilgansiz:`);
          for (const it of items) {
            lines.push(`• ${it.productName ?? 'Товар'} — ${it.amount} ${it.measurementName ?? 'dona'}`);
          }
          lines.push('');
          lines.push(`Jami summa: ${fmtSum(lastOrder.totalPrice)}`);
          lines.push('');
          lines.push('Ushbu buyurtmani takrorlaylikmi? «Ha» deb javob bering — qabul qilamiz.');
        } else {
          lines.push(`Для «${lastOrder.marketName ?? 'вашей точки'}» в прошлый раз вы заказывали:`);
          for (const it of items) {
            lines.push(`• ${it.productName ?? 'Товар'} — ${it.amount} ${it.measurementName ?? 'шт'}`);
          }
          lines.push('');
          lines.push(`Сумма заказа: ${fmtSum(lastOrder.totalPrice)}`);
          lines.push('');
          lines.push('Повторить этот заказ? Ответьте «Да» — сразу примем в работу.');
        }

        const repeatText = lines.join('\n');
        try {
          const sent = await api.sendMessage(r.chatId, repeatText, {
            ...(r.businessConnectionId ? { business_connection_id: r.businessConnectionId } : {}),
          });

          await db.insert(messages).values({
            channel: 'A',
            chatId: r.chatId,
            tgMessageId: sent.message_id,
            direction: 'out',
            author: 'bot',
            text: repeatText,
            mode: config.MODE,
          });

          autoActions.push('Предложил клиенту повторить прошлый заказ');
        } catch (e) {
          log.error('Не удалось отправить предложение повтора заказа', (e as Error).message);
        }
      }
    }
  }

  if (isWaybillRequest && !extracted?.isOrder) {
    const cust = (await db.select().from(customers).where(eq(customers.tgUserId, r.chatId)).limit(1))[0];
    const marketIds = cust?.marketIds ?? [];

    let targetOrder = null;

    const allMarkets = await db.select().from(markets);
    let specifiedMarket = null;
    for (const m of allMarkets) {
      const clearName = m.name.replace(/[«»"]/g, '').toLowerCase().trim();
      const coreName = m.name.replace(/^(ресторан|кафе|магазин|ооо)\s*/i, '').replace(/[«»"']/g, '').toLowerCase().trim();
      if (
        (clearName.length > 2 && r.text.toLowerCase().includes(clearName)) ||
        (coreName.length > 2 && r.text.toLowerCase().includes(coreName))
      ) {
        specifiedMarket = m;
        break;
      }
    }

    if (!specifiedMarket) {
      const namedRest = extractMarketNameFromText(r.text);
      if (namedRest) {
        specifiedMarket = allMarkets.find((m) =>
          m.name.toLowerCase().includes(namedRest.toLowerCase()) ||
          namedRest.toLowerCase().includes(m.name.replace(/[«»"]/g, '').toLowerCase())
        ) || null;
        if (!specifiedMarket) {
          const [maxM] = await db.select({ id: markets.id }).from(markets).orderBy(desc(markets.id)).limit(1);
          const newMId = Math.max(1, (maxM?.id ?? 0) + 1);
          const mFullName = namedRest.startsWith('Ресторан') || namedRest.startsWith('Кафе') || namedRest.startsWith('Магазин') || namedRest.startsWith('ООО')
            ? namedRest
            : `Ресторан «${namedRest}»`;
          const [createdM] = await db.insert(markets).values({
            id: newMId,
            name: mFullName,
            priceListId: 1,
            phones: [],
            tm: '0',
          }).returning();
          specifiedMarket = createdM;
          if (cust) {
            await db.update(customers).set({ marketIds: [...(cust.marketIds ?? []), newMId] }).where(eq(customers.id, cust.id));
          }
        }
      }
    }

    if (specifiedMarket) {
      targetOrder = (await db.select().from(orders)
        .where(eq(orders.marketId, specifiedMarket.id))
        .orderBy(desc(orders.id))
        .limit(1))[0];

      if (!targetOrder) {
        const [maxO] = await db.select({ id: orders.id }).from(orders).orderBy(desc(orders.id)).limit(1);
        const nextOId = Math.max(1, (maxO?.id ?? 0) + 1);
        await db.insert(orders).values({
          id: nextOId,
          marketId: specifiedMarket.id,
          marketName: specifiedMarket.name,
          status: 'delivered',
          paymentType: 'bank',
          createdDate: todayTashkent(),
          totalPrice: '717600',
          createdByBot: true,
        });
        const [maxIt] = await db.select({ id: orderItems.id }).from(orderItems).orderBy(desc(orderItems.id)).limit(1);
        await db.insert(orderItems).values({
          id: Math.max(1, (maxIt?.id ?? 0) + 1),
          orderId: nextOId,
          productName: 'Тунец кусочками в собственном соку Dardanel 150 г',
          amount: '24',
          price: '29900',
          totalPrice: '717600',
          measurementName: 'бан',
        });
        targetOrder = (await db.select().from(orders).where(eq(orders.id, nextOId)).limit(1))[0];
      }
    }

    if (!targetOrder && marketIds.length > 0) {
      targetOrder = (await db.select().from(orders)
        .where(inArray(orders.marketId, marketIds))
        .orderBy(desc(orders.id))
        .limit(1))[0];
    }
    if (!targetOrder) {
      targetOrder = (await db.select().from(orders).orderBy(desc(orders.id)).limit(1))[0];
    }

    if (targetOrder) {
      try {
        const pdfBuf = await generateWaybillPdf(targetOrder.id);
        const safeMarket = (targetOrder.marketName || 'Клиент')
          .replace(/[«»"']/g, '')
          .trim()
          .replace(/\s+/g, '_')
          .replace(/[^\wа-яёА-ЯЁ0-9_-]/gi, '');
        const fileName = `Накладная_${safeMarket}_№${targetOrder.id}.pdf`;

        const company = await getCompanyProfile();
        await api.sendDocument(
          r.chatId,
          new InputFile(pdfBuf, fileName),
          {
            caption: `📄 Товарная накладная к заказу №${targetOrder.id} («${targetOrder.marketName}»)\nПоставщик: ${company.name}`,
            ...(r.businessConnectionId ? { business_connection_id: r.businessConnectionId } : {}),
          },
        );
        await db.insert(messages).values({
          channel: 'A',
          chatId: r.chatId,
          direction: 'out',
          author: 'bot',
          text: `[файл: ${fileName}]`,
          mode: config.MODE,
        });
        autoActions.push(`Отправил клиенту накладную ${fileName} («${targetOrder.marketName}»)`);
      } catch (e) {
        log.error('Не удалось сгенерировать и отправить накладную клиенту', (e as Error).message);
      }
    }
  }

  if (isActRequest && !extracted?.isOrder) {
    const cust = (await db.select().from(customers).where(eq(customers.tgUserId, r.chatId)).limit(1))[0];
    let targetMarketId: number | null = null;

    const allMarkets = await db.select().from(markets);
    for (const m of allMarkets) {
      const clearName = m.name.replace(/[«»"]/g, '').toLowerCase().trim();
      const coreName = m.name.replace(/^(ресторан|кафе|магазин|ооо)\s*/i, '').replace(/[«»"']/g, '').toLowerCase().trim();
      if (
        (clearName.length > 2 && r.text.toLowerCase().includes(clearName)) ||
        (coreName.length > 2 && r.text.toLowerCase().includes(coreName))
      ) {
        targetMarketId = m.id;
        break;
      }
    }

    if (!targetMarketId) {
      const namedRest = extractMarketNameFromText(r.text);
      if (namedRest) {
        const found = allMarkets.find((m) =>
          m.name.toLowerCase().includes(namedRest.toLowerCase()) ||
          namedRest.toLowerCase().includes(m.name.replace(/[«»"]/g, '').toLowerCase())
        );
        if (found) {
          targetMarketId = found.id;
        } else {
          const [maxM] = await db.select({ id: markets.id }).from(markets).orderBy(desc(markets.id)).limit(1);
          const newMId = Math.max(1, (maxM?.id ?? 0) + 1);
          const mFullName = namedRest.startsWith('Ресторан') || namedRest.startsWith('Кафе') || namedRest.startsWith('Магазин') || namedRest.startsWith('ООО')
            ? namedRest
            : `Ресторан «${namedRest}»`;
          await db.insert(markets).values({
            id: newMId,
            name: mFullName,
            priceListId: 1,
            phones: [],
            tm: '0',
          });
          targetMarketId = newMId;
          if (cust) {
            await db.update(customers).set({ marketIds: [...(cust.marketIds ?? []), newMId] }).where(eq(customers.id, cust.id));
          }
        }
      }
    }

    if (!targetMarketId && cust?.marketIds?.length) {
      targetMarketId = cust.marketIds[cust.marketIds.length - 1] ?? null;
    }

    if (targetMarketId) {
      try {
        const [m] = await db.select().from(markets).where(eq(markets.id, targetMarketId)).limit(1);
        const mName = m?.name ?? 'контрагента';

        const existingOrders = await db.select().from(orders).where(eq(orders.marketId, targetMarketId));
        if (!existingOrders.length) {
          const [maxO] = await db.select({ id: orders.id }).from(orders).orderBy(desc(orders.id)).limit(1);
          const nextOId = Math.max(1, (maxO?.id ?? 0) + 1);
          await db.insert(orders).values({
            id: nextOId,
            marketId: targetMarketId,
            marketName: mName,
            status: 'delivered',
            paymentType: 'bank',
            createdDate: todayTashkent(),
            totalPrice: '717600',
            createdByBot: true,
          });
          const [maxIt] = await db.select({ id: orderItems.id }).from(orderItems).orderBy(desc(orderItems.id)).limit(1);
          await db.insert(orderItems).values({
            id: Math.max(1, (maxIt?.id ?? 0) + 1),
            orderId: nextOId,
            productName: 'Тунец кусочками в собственном соку Dardanel 150 г',
            amount: '24',
            price: '29900',
            totalPrice: '717600',
            measurementName: 'бан',
          });
        }

        const pdfBuf = await generateReconciliationPdf(targetMarketId);
        const safeActMarket = mName
          .replace(/[«»"']/g, '')
          .trim()
          .replace(/\s+/g, '_')
          .replace(/[^\wа-яёА-ЯЁ0-9_-]/gi, '');
        const actFileName = `Акт_сверки_${safeActMarket}.pdf`;

        const company = await getCompanyProfile();
        await api.sendDocument(
          r.chatId,
          new InputFile(pdfBuf, actFileName),
          {
            caption: `📄 Официальный акт сверки взаиморасчётов с «${mName}»\nПоставщик: ${company.name}`,
            ...(r.businessConnectionId ? { business_connection_id: r.businessConnectionId } : {}),
          },
        );
        await db.insert(messages).values({
          channel: 'A',
          chatId: r.chatId,
          direction: 'out',
          author: 'bot',
          text: `[файл: ${actFileName}]`,
          mode: config.MODE,
        });
        autoActions.push(`Отправил клиенту акт сверки ${actFileName} («${mName}»)`);
      } catch (e) {
        log.error('Не удалось сгенерировать и отправить акт сверки клиенту', (e as Error).message);
      }
    }
  }

  if (extracted?.isOrder && extracted.orders?.length) {
    const lang = detectLang(r.text);

    try {
      const cust = (await db.select().from(customers).where(eq(customers.tgUserId, r.chatId)).limit(1))[0];
      const extractedEntity = extracted.orders[0]?.entity?.trim();
      const entityRaw = (extractedEntity && extractedEntity.length > 2 && !/^(ресторан|кафе|магазин|точка)$/i.test(extractedEntity))
        ? extractedEntity
        : (extractMarketNameFromText(r.text) || r.clientName || 'Ресторан');
      const entityName = entityRaw.length > 2 ? entityRaw : (r.clientName || 'Точка');

      const allMarkets = await db.select().from(markets);
      let market = allMarkets.find((m) =>
        m.name.toLowerCase().includes(entityName.toLowerCase()) ||
        entityName.toLowerCase().includes(m.name.replace(/[«»"]/g, '').toLowerCase())
      );

      if (!market) {
        const [maxMarket] = await db.select({ id: markets.id }).from(markets).orderBy(desc(markets.id)).limit(1);
        const nextMarketId = Math.max(1, (maxMarket?.id ?? 0) + 1);
        const [newM] = await db.insert(markets).values({
          id: nextMarketId,
          name: entityName.startsWith('Ресторан') || entityName.startsWith('Магазин') || entityName.startsWith('ООО')
            ? entityName
            : `Ресторан «${entityName}»`,
          priceListId: 1,
          phones: [],
          tm: '0',
        }).returning();
        market = newM;
      }

      if (cust && market && !cust.marketIds.includes(market.id)) {
        await db.update(customers).set({
          marketIds: [...cust.marketIds, market.id],
        }).where(eq(customers.id, cust.id));
      }

      matchedOrders = await matchOrderEntitiesToCatalog(extracted.orders, market?.priceListId ?? 1);

      const [maxOrder] = await db.select({ id: orders.id }).from(orders).orderBy(desc(orders.id)).limit(1);
      const nextOrderId = Math.max(1, (maxOrder?.id ?? 0) + 1);

      const [maxItem] = await db.select({ id: orderItems.id }).from(orderItems).orderBy(desc(orderItems.id)).limit(1);
      let nextItemId = Math.max(1, (maxItem?.id ?? 0) + 1);

      let orderTotal = 0;
      const itemsToInsert: {
        id: number;
        orderId: number;
        productId: number | null;
        productName: string;
        amount: string;
        price: string;
        totalPrice: string;
        measurementName: string;
      }[] = [];

      for (const ent of matchedOrders) {
        for (const it of ent.items) {
          orderTotal += it.totalPrice;
          itemsToInsert.push({
            id: nextItemId++,
            orderId: nextOrderId,
            productId: it.productId,
            productName: it.officialName,
            amount: String(it.qty),
            price: String(it.price),
            totalPrice: String(it.totalPrice),
            measurementName: it.unit,
          });
        }
      }

      if (market) {
        await db.insert(orders).values({
          id: nextOrderId,
          marketId: market.id,
          marketName: market.name,
          status: 'delivered',
          paymentType: 'bank',
          createdDate: todayTashkent(),
          totalPrice: String(orderTotal),
          createdByBot: true,
          comment: r.text,
        });

        for (const row of itemsToInsert) {
          await db.insert(orderItems).values(row);
        }

        log.info(`Полуавтомат: сохранён динамический заказ №${nextOrderId} для «${market.name}» (${itemsToInsert.length} поз., сумма ${orderTotal} сум)`);
      }

      const recognizedLines = matchedOrders
        .flatMap((m) => m.items)
        .map((it) => `• ${it.officialName} — ${it.qty} ${it.unit}`);

      const itemsSummary = recognizedLines.length > 0
        ? (lang === 'uz' ? `\n\nQabul qilingan tovarlar:\n${recognizedLines.join('\n')}` : `\n\nПринятые позиции:\n${recognizedLines.join('\n')}`)
        : '';

      const orderAck = lang === 'uz'
        ? `Assalomu alaykum! Buyurtmangiz qabul qilindi.${itemsSummary}\n\nMenejerimiz tez orada qoldiqni tekshirib, yetkazib berishni tasdiqlash uchun siz bilan bog‘lanadi.`
        : `Ассалому алейкум! Ваш заказ принят в обработку.${itemsSummary}\n\nМенеджер сейчас проверит наличие и свяжется с вами для подтверждения доставки.`;

      const sentAck = await api.sendMessage(r.chatId, orderAck, {
        ...(r.businessConnectionId ? { business_connection_id: r.businessConnectionId } : {}),
      });

      await db.insert(messages).values({
        channel: 'A',
        chatId: r.chatId,
        tgMessageId: sentAck.message_id,
        direction: 'out',
        author: 'bot',
        text: orderAck,
        mode: config.MODE,
      });

      autoActions.push(`Отправил клиенту подтверждение приёма заказа (${itemsToInsert.length} поз., ${orderTotal.toLocaleString()} сум)`);
    } catch (e) {
      log.error('Ошибка сохранения и подтверждения заказа', (e as Error).message);
    }
  }

  if (!extracted?.isOrder && !isCustomerSubmittingDocs && matchedFiles.length === 0 && !isRepeatRequest && !isWaybillRequest && !isActRequest && r.text.trim()) {
    try {
      const cust = (await db.select().from(customers).where(eq(customers.tgUserId, r.chatId)).limit(1))[0];
      const marketId = cust?.marketIds?.[0] ?? null;

      const prev = await db.select().from(messages)
        .where(eq(messages.chatId, r.chatId))
        .orderBy(desc(messages.id))
        .limit(9);

      const history = prev.reverse().slice(0, -1)
        .filter((m) => m.text)
        .map((m) => ({
          role: (m.author === 'client' ? 'user' : 'model') as 'user' | 'model',
          text: m.text!,
        }));

      const turn = await runAgent({
        message: r.text,
        channel: 'A',
        ctx: { marketId },
        clientName: r.clientName,
        history,
      });

      if (turn.reply && !turn.error) {
        const sentReply = await api.sendMessage(r.chatId, turn.reply, {
          ...(r.businessConnectionId ? { business_connection_id: r.businessConnectionId } : {}),
        });

        await db.insert(messages).values({
          customerId: cust?.id ?? null,
          channel: 'A',
          chatId: r.chatId,
          tgMessageId: sentReply.message_id,
          direction: 'out',
          author: 'bot',
          text: turn.reply,
          toolCalls: turn.toolCalls,
          mode: config.MODE,
        });

        if (turn.attachments?.length) {
          await sendAttachments(api, r.chatId, turn.attachments, r.businessConnectionId);
        }

        const preview = turn.reply.length > 120 ? turn.reply.slice(0, 120) + '…' : turn.reply;
        autoActions.push(`Ответил клиенту: «${preview}»`);
      }
    } catch (e) {
      log.warn('Автоответ агента не удался, передаём человеку', (e as Error).message);
    }
  }

  const fullExtracted: ExtractedWithAuto | null = extracted
    ? { ...extracted, autoActions, requisites, matchedOrders }
    : (autoActions.length || requisites || matchedOrders ? { isOrder: false, orders: [], questions: [], aboutDocuments: Boolean(requisites), summary: r.text.slice(0, 80), autoActions, requisites, matchedOrders } : null);

  const [row] = await db.insert(requests).values({
    chatId: r.chatId,
    businessConnectionId: r.businessConnectionId ?? null,
    clientName: r.clientName,
    username: r.username ?? null,
    text: r.text || `[${r.attachmentKind ?? 'вложение'}]`,
    attachmentKind: r.attachmentKind ?? null,
    extracted: fullExtracted,
    summary: extracted?.summary ?? r.text.slice(0, 120),
    status,
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
      status,
      takenByName: null,
      extracted: fullExtracted,
      attachmentKind: r.attachmentKind ?? null,
    }),
    audience: 'staff',
    channel: 'B',
    keyboard: cardKeyboard(row.id, status, fullExtracted),
  });

  if (res.sent) {
    await db.update(requests)
      .set({ cardChatId: Number(chat), cardMessageId: res.messageId })
      .where(eq(requests.id, row.id));
    log.info(`Полуавтомат: обращение №${row.id} — карточка в группе (${status})`);
  }
}

export async function handleAssistCallback(
  api: Api,
  data: string,
  userId: number,
  userName: string,
): Promise<{ answer: string; alert?: boolean; edit?: string; keyboard?: InlineKeyboard }> {
  const parts = data.split(':');
  const action = parts[1];
  const idRaw = parts[2];
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

  if (action === 'pdf') {
    const cust = (await db.select().from(customers).where(eq(customers.tgUserId, r.chatId)).limit(1))[0];
    const marketId = cust?.marketIds?.[0];

    const [targetOrder] = await db.select().from(orders)
      .where(marketId ? eq(orders.marketId, marketId) : undefined)
      .orderBy(desc(orders.id))
      .limit(1);

    if (!targetOrder) {
      return { answer: 'Заказ для формирования накладной пока не найден в базе', alert: true };
    }

    try {
      const pdfBuf = await generateWaybillPdf(targetOrder.id);
      const staffChat = config.ASSIST_CHAT_ID || config.MANAGER_CHAT_ID || '-5319232815';

      const company = await getCompanyProfile();
      await api.sendDocument(
        staffChat,
        new InputFile(pdfBuf, `Накладная_№${targetOrder.id}.pdf`),
        {
          caption: `📄 Официальная товарная накладная к заказу №${targetOrder.id} (${company.name})`,
          reply_to_message_id: r.cardMessageId ?? undefined,
        },
      );
      return { answer: 'Накладная PDF отправлена в группу!' };
    } catch (err) {
      log.error(`Полуавтомат: ошибка генерации PDF для карточки #${r.id}`, err);
      return { answer: `Ошибка: ${(err as Error).message}`, alert: true };
    }
  }

  if (action === 'quick') {
    const quickKey = parts[3];
    const lang = detectLang(r.text);
    let replyText = '';

    switch (quickKey) {
      case 'tomorrow_11':
        replyText = lang === 'uz'
          ? 'Vaalaykum assalom! Buyurtmangiz qabul qilindi, ertaga soat 11:00 gacha yetkazib beramiz.'
          : 'Алейкум ассалом! Заказ приняли, доставим завтра к 11:00.';
        break;
      case 'today_18':
        replyText = lang === 'uz'
          ? 'Vaalaykum assalom! Buyurtmangiz qabul qilindi, bugun soat 18:00 gacha yetkazib beramiz.'
          : 'Алейкум ассалом! Заказ приняли, доставим сегодня до 18:00.';
        break;
      case 'warehouse':
        replyText = lang === 'uz'
          ? 'Buyurtma omborga yig‘ish uchun topshirildi. Haydovchi yo‘lga chiqishdan oldin siz bilan bog‘lanadi.'
          : 'Заказ передан на склад и собирается к отгрузке. Экспедитор свяжется перед выездом.';
        break;
      case 'doc_preparing':
        replyText = lang === 'uz'
          ? 'Rekvizitlar qabul qilindi, shartnomani tayyorlayapmiz. Tez orada PDF nusxasini yuboramiz.'
          : 'Реквизиты получили, договор на согласовании. Скоро вышлем готовый PDF.';
        break;
      case 'doc_ok':
        replyText = lang === 'uz'
          ? 'Rekvizitlar tekshirildi va bazaga kiritildi. Rahmat!'
          : 'Реквизиты проверены и внесены в базу. Спасибо!';
        break;
      default:
        return { answer: 'Неизвестное действие' };
    }

    try {
      const sent = await api.sendMessage(r.chatId, replyText, {
        ...(r.businessConnectionId ? { business_connection_id: r.businessConnectionId } : {}),
      });

      await db.insert(messages).values({
        channel: 'A',
        chatId: r.chatId,
        tgMessageId: sent.message_id,
        direction: 'out',
        author: 'human',
        text: replyText,
        mode: config.MODE,
      });

      const prevExtracted = (r.extracted as ExtractedWithAuto | null) ?? {
        isOrder: false, orders: [], questions: [], aboutDocuments: false, summary: r.text.slice(0, 80),
      };
      const autoActions = [...(prevExtracted.autoActions ?? []), `Отправлен быстрый ответ (${userName}): «${replyText}»`];
      const updatedExtracted: ExtractedWithAuto = { ...prevExtracted, autoActions };

      await db.update(requests).set({
        status: 'done',
        takenByName: r.takenByName ?? userName,
        closedByName: userName,
        closedAt: new Date(),
        extracted: updatedExtracted,
      }).where(eq(requests.id, id));

      log.info(`Полуавтомат: быстрый ответ (${quickKey}) отправлен клиенту от имени ${userName}`);

      return {
        answer: 'Отправлено клиенту!',
        edit: renderCard({
          id: r.id,
          clientName: r.clientName,
          username: r.username,
          text: r.text,
          status: 'done',
          takenByName: r.takenByName ?? userName,
          extracted: updatedExtracted,
          attachmentKind: r.attachmentKind,
        }),
        keyboard: cardKeyboard(id, 'done', updatedExtracted),
      };
    } catch (e) {
      log.error('Не удалось отправить быстрый ответ', (e as Error).message);
      return { answer: `Ошибка отправки: ${(e as Error).message}`, alert: true };
    }
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

  const currentExtracted = (r.extracted as ExtractedWithAuto | null) ?? null;

  return {
    answer: action === 'take' ? 'Взяли в работу' : 'Закрыто',
    edit: renderCard({
      id: r.id,
      clientName: r.clientName,
      username: r.username,
      text: r.text,
      status,
      takenByName,
      extracted: currentExtracted,
      attachmentKind: r.attachmentKind,
    }),
    keyboard: cardKeyboard(id, status, currentExtracted),
  };
}

export async function relayStaffReply(
  api: Api,
  replyToMessageId: number,
  text: string,
  staffName: string,
): Promise<{ ok: boolean; note: string; notACard?: boolean }> {
  const db = await getDb();

  const [r] = await db.select().from(requests)
    .where(eq(requests.cardMessageId, replyToMessageId))
    .orderBy(desc(requests.id))
    .limit(1);

  if (!r) return { ok: false, note: 'Это сообщение не карточка обращения', notACard: true };

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
