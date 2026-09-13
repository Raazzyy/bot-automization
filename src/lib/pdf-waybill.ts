import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { eq, inArray, desc, and } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { orders, orderItems, markets, payments } from '../db/schema.js';
import { fmtSum, fmtDate, fmtNum, fmtAmount, todayTashkent, toSum } from './money.js';
import { config } from '../config.js';
import { log } from './logger.js';
import { getCompanyProfile } from './settings.js';


const COMPANY_INFO = {
  name: 'ООО «AKM HOLDINGS INC»',
  inn: '308057864',
  mfo: '00440',
  account: '2020 8000 0053 2388 6001',
  bank: 'АКБ "УЗСАНОАТКУРИЛИШБАНКИ"',
  address: 'г. Ташкент, Мирабадский район, ул. Сайхун, дом 170А/16',
  phone: '+998 99 9255955',
};

/** Загрузка шрифтов с поддержкой кириллицы и узбекского языка */
async function loadFonts(doc: PDFDocument) {
  doc.registerFontkit(fontkit);

  let fontPath = join(process.cwd(), 'assets', 'fonts', 'arial.ttf');
  let fontBoldPath = join(process.cwd(), 'assets', 'fonts', 'arialbd.ttf');

  if (!existsSync(fontPath)) {
    fontPath = 'C:\\Windows\\Fonts\\arial.ttf';
    fontBoldPath = 'C:\\Windows\\Fonts\\arialbd.ttf';
  }

  const fontBytes = readFileSync(fontPath);
  const fontBoldBytes = existsSync(fontBoldPath) ? readFileSync(fontBoldPath) : fontBytes;

  const regularFont = await doc.embedFont(fontBytes);
  const boldFont = await doc.embedFont(fontBoldBytes);

  return { regularFont, boldFont };
}

/**
 * Генерация официальной товарной накладной в PDF
 */
export async function generateWaybillPdf(orderId: number): Promise<Buffer> {
  const db = await getDb();

  const [o] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!o) throw new Error(`Заказ №${orderId} не найден`);

  const company = await getCompanyProfile();
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const market = o.marketId ? (await db.select().from(markets).where(eq(markets.id, o.marketId)).limit(1))[0] : null;

  const pdfDoc = await PDFDocument.create();
  const { regularFont, boldFont } = await loadFonts(pdfDoc);

  // A4: 595.28 x 841.89
  const page = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();

  const marginX = 40;
  let cursorY = height - 40;

  // --- ЗАГОЛОВОК ДОКУМЕНТА ---
  cursorY -= 10;
  const docTitle = `ТОВАРНАЯ НАКЛАДНАЯ № ${Math.abs(o.id)} от ${fmtDate(o.createdDate)}`;
  const titleWidth = boldFont.widthOfTextAtSize(docTitle, 13);
  page.drawText(docTitle, {
    x: (width - titleWidth) / 2,
    y: cursorY,
    size: 13,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.1),
  });

  // --- РЕКВИЗИТЫ СТОРОН ---
  cursorY -= 22;
  page.drawText(`Поставщик: ${company.name}`, { x: marginX, y: cursorY, size: 9.5, font: boldFont });
  cursorY -= 14;
  const buyerName = o.marketName || market?.name || 'Покупатель не указан';
  const buyerInn = o.marketInn || market?.inn || '—';
  const buyerAddress = market?.address || 'г. Ташкент';
  const phones = (market?.phones as string[]) ?? [];
  const buyerPhone = phones[0] || '—';

  page.drawText(`Покупатель: ${buyerName}`, { x: marginX, y: cursorY, size: 9.5, font: boldFont });
  cursorY -= 14;
  page.drawText(`ИНН: ${buyerInn}   ·   Тел: ${buyerPhone}`, { x: marginX, y: cursorY, size: 8.5, font: regularFont });
  cursorY -= 13;
  page.drawText(`Адрес доставки: ${buyerAddress}`, { x: marginX, y: cursorY, size: 8.5, font: regularFont });
  cursorY -= 13;
  const payLabel = o.paymentType === 'bank' ? 'Перечисление' : 'Наличные';
  page.drawText(`Форма оплаты: ${payLabel}${o.paymentDate ? ` · Срок оплаты: ${fmtDate(o.paymentDate)}` : ''}`, {
    x: marginX,
    y: cursorY,
    size: 8.5,
    font: regularFont,
  });

  // --- ТАБЛИЦА ТОВАРОВ ---
  cursorY -= 20;

  // Колонки таблицы:
  // № (25) | Наименование (230) | Ед. (35) | Кол-во (50) | Цена (85) | Сумма (90) = 515
  const colX = {
    num: marginX,
    name: marginX + 25,
    unit: marginX + 255,
    qty: marginX + 290,
    price: marginX + 340,
    total: marginX + 425,
    end: width - marginX,
  };

  const rowHeight = 20;

  // Заголовок таблицы (серый фон)
  page.drawRectangle({
    x: marginX,
    y: cursorY - 5,
    width: width - marginX * 2,
    height: rowHeight,
    color: rgb(0.92, 0.94, 0.93),
  });

  page.drawText('№', { x: colX.num + 5, y: cursorY, size: 8.5, font: boldFont });
  page.drawText('Товары (наименование)', { x: colX.name + 5, y: cursorY, size: 8.5, font: boldFont });
  page.drawText('Ед.', { x: colX.unit + 5, y: cursorY, size: 8.5, font: boldFont });
  page.drawText('Кол-во', { x: colX.qty + 5, y: cursorY, size: 8.5, font: boldFont });
  page.drawText('Цена (сум)', { x: colX.price + 5, y: cursorY, size: 8.5, font: boldFont });
  page.drawText('Сумма (сум)', { x: colX.total + 5, y: cursorY, size: 8.5, font: boldFont });

  // Граница заголовка
  page.drawRectangle({
    x: marginX,
    y: cursorY - 5,
    width: width - marginX * 2,
    height: rowHeight,
    borderWidth: 0.8,
    borderColor: rgb(0.5, 0.5, 0.5),
  });

  cursorY -= rowHeight;

  // Строки товаров
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;

    page.drawRectangle({
      x: marginX,
      y: cursorY - 5,
      width: width - marginX * 2,
      height: rowHeight,
      borderWidth: 0.5,
      borderColor: rgb(0.8, 0.8, 0.8),
    });

    const shortName = (it.productName || `Товар #${it.productId}`).slice(0, 42);
    page.drawText(String(i + 1), { x: colX.num + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText(shortName, { x: colX.name + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText(it.measurementName || 'шт', { x: colX.unit + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText(fmtAmount(it.amount), { x: colX.qty + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText(fmtNum(it.price), { x: colX.price + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText(fmtNum(it.totalPrice), { x: colX.total + 5, y: cursorY, size: 8, font: boldFont });

    cursorY -= rowHeight;
  }

  // --- ИТОГИ ---
  cursorY -= 8;
  const discount = Number(o.discountPrice ?? 0);
  if (discount > 0) {
    page.drawText(`Скидка: -${fmtSum(discount)}`, {
      x: colX.price - 40,
      y: cursorY,
      size: 9,
      font: regularFont,
      color: rgb(0.5, 0.2, 0.2),
    });
    cursorY -= 14;
  }

  page.drawText(`ИТОГО К ОПЛАТЕ: ${fmtSum(o.totalPrice)}`, {
    x: colX.price - 40,
    y: cursorY,
    size: 10.5,
    font: boldFont,
    color: rgb(0.08, 0.35, 0.3),
  });

  cursorY -= 20;
  page.drawText(`Всего наименований: ${items.length}, на сумму: ${fmtSum(o.totalPrice)}. Без НДС.`, {
    x: marginX,
    y: cursorY,
    size: 8.5,
    font: regularFont,
  });

  // --- ПОДПИСИ СТОРОН ---
  cursorY -= 50;
  page.drawLine({
    start: { x: marginX, y: cursorY + 15 },
    end: { x: width - marginX, y: cursorY + 15 },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });

  const colWidth = (width - marginX * 2 - 40) / 2;

  // Поставщик
  page.drawText('Отпустил (Поставщик):', { x: marginX, y: cursorY, size: 9, font: boldFont });
  page.drawText('Экспедитор: __________________________', { x: marginX, y: cursorY - 18, size: 8.5, font: regularFont });
  page.drawText('(подпись / Ф.И.О.)', { x: marginX + 60, y: cursorY - 28, size: 7, font: regularFont, color: rgb(0.5, 0.5, 0.5) });
  page.drawText('М.П.', { x: marginX + 180, y: cursorY - 45, size: 10, font: boldFont, color: rgb(0.6, 0.6, 0.6) });

  // Покупатель
  const rightX = marginX + colWidth + 40;
  page.drawText('Принял (Покупатель):', { x: rightX, y: cursorY, size: 9, font: boldFont });
  page.drawText('Заказчик: ____________________________', { x: rightX, y: cursorY - 18, size: 8.5, font: regularFont });
  page.drawText('(подпись / Ф.И.О.)', { x: rightX + 60, y: cursorY - 28, size: 7, font: regularFont, color: rgb(0.5, 0.5, 0.5) });
  page.drawText('М.П.', { x: rightX + 180, y: cursorY - 45, size: 10, font: boldFont, color: rgb(0.6, 0.6, 0.6) });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Генерация официального акта сверки взаимных расчетов в PDF
 */
export async function generateReconciliationPdf(marketId: number): Promise<Buffer> {
  const db = await getDb();

  const [market] = await db.select().from(markets).where(eq(markets.id, marketId)).limit(1);
  if (!market) throw new Error(`Точка #${marketId} не найдена`);

  const mOrders = await db
    .select()
    .from(orders)
    .where(and(
      eq(orders.marketId, marketId),
      inArray(orders.status, ['delivered', 'given', 'success']),
    ))
    .orderBy(orders.createdDate, orders.id);

  const mPayments = await db
    .select()
    .from(payments)
    .where(and(
      eq(payments.marketId, marketId),
      eq(payments.status, 'accepted'),
      eq(payments.isDelete, false),
    ))
    .orderBy(payments.createdDate, payments.id);

  const pdfDoc = await PDFDocument.create();
  const { regularFont, boldFont } = await loadFonts(pdfDoc);
  const company = await getCompanyProfile();

  const page = pdfDoc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  const marginX = 40;
  let cursorY = height - 40;

  // Шапка
  page.drawText(company.name, { x: marginX, y: cursorY, size: 12, font: boldFont, color: rgb(0.08, 0.35, 0.3) });
  cursorY -= 14;
  page.drawText(`ИНН: ${company.inn} · Тел: ${company.phone}`, { x: marginX, y: cursorY, size: 8, font: regularFont });

  cursorY -= 22;
  const title = `АКТ СВЕРКИ ВЗАИМНЫХ РАСЧЕТОВ`;
  const titleW = boldFont.widthOfTextAtSize(title, 13);
  page.drawText(title, { x: (width - titleW) / 2, y: cursorY, size: 13, font: boldFont });

  cursorY -= 16;
  const sub = `между ${company.name} и «${market.name}» по состоянию на ${fmtDate(todayTashkent())}`;
  const subW = regularFont.widthOfTextAtSize(sub, 9);
  page.drawText(sub, { x: (width - subW) / 2, y: cursorY, size: 9, font: regularFont });

  cursorY -= 20;

  // Таблица операций
  // Дата (65) | Документ / Операция (200) | Дебет / Отгрузка (120) | Кредит / Оплата (130)
  const colX = {
    date: marginX,
    doc: marginX + 65,
    debet: marginX + 265,
    credit: marginX + 385,
    end: width - marginX,
  };

  const rowH = 18;

  page.drawRectangle({
    x: marginX, y: cursorY - 5, width: width - marginX * 2, height: rowH, color: rgb(0.92, 0.94, 0.93),
  });

  page.drawText('Дата', { x: colX.date + 5, y: cursorY, size: 8.5, font: boldFont });
  page.drawText('Документ / Основание', { x: colX.doc + 5, y: cursorY, size: 8.5, font: boldFont });
  page.drawText('Отгрузка (дебет)', { x: colX.debet + 5, y: cursorY, size: 8.5, font: boldFont });
  page.drawText('Оплата (кредит)', { x: colX.credit + 5, y: cursorY, size: 8.5, font: boldFont });
  cursorY -= rowH;

  let totalOrders = 0;
  let totalPayments = 0;

  // Накладные
  for (const o of mOrders) {
    const sum = toSum(o.totalPrice);
    totalOrders += sum;

    page.drawText(fmtDate(o.createdDate), { x: colX.date + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText(`Накладная №${Math.abs(o.id)}`, { x: colX.doc + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText(fmtSum(sum), { x: colX.debet + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText('—', { x: colX.credit + 5, y: cursorY, size: 8, font: regularFont });
    cursorY -= rowH;
  }

  // Оплаты
  for (const p of mPayments) {
    const sum = toSum(p.amount);
    totalPayments += sum;

    page.drawText(fmtDate(p.createdDate), { x: colX.date + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText(`Оплата №${Math.abs(p.id)} (${p.paymentType ?? 'банк'})`, { x: colX.doc + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText('—', { x: colX.debet + 5, y: cursorY, size: 8, font: regularFont });
    page.drawText(fmtSum(sum), { x: colX.credit + 5, y: cursorY, size: 8, font: regularFont });
    cursorY -= rowH;
  }

  // Линия итога
  cursorY -= 8;
  page.drawLine({
    start: { x: marginX, y: cursorY + 12 },
    end: { x: width - marginX, y: cursorY + 12 },
    thickness: 1,
    color: rgb(0.2, 0.2, 0.2),
  });

  const finalDebt = totalOrders - totalPayments;

  page.drawText(`Всего отгружено: ${fmtSum(totalOrders)}   ·   Всего оплачено: ${fmtSum(totalPayments)}`, {
    x: marginX,
    y: cursorY,
    size: 9,
    font: boldFont,
  });

  cursorY -= 16;
  const debtStatus = finalDebt > 0
    ? `Задолженность в пользу ${company.name}: ${fmtSum(finalDebt)}`
    : (finalDebt < 0 ? `Переплата в пользу Покупателя: ${fmtSum(Math.abs(finalDebt))}` : 'Задолженность отсутствует (сальдо 0 сум).');

  page.drawText(debtStatus, {
    x: marginX,
    y: cursorY,
    size: 10,
    font: boldFont,
    color: finalDebt > 0 ? rgb(0.7, 0.2, 0.2) : rgb(0.1, 0.4, 0.2),
  });

  // Подписи
  cursorY -= 50;
  const colW = (width - marginX * 2 - 40) / 2;
  page.drawText(`От ${company.name}:`, { x: marginX, y: cursorY, size: 9, font: boldFont });
  page.drawText('Главный бухгалтер: ___________________', { x: marginX, y: cursorY - 18, size: 8.5, font: regularFont });
  page.drawText('М.П.', { x: marginX + 160, y: cursorY - 40, size: 10, font: boldFont, color: rgb(0.6, 0.6, 0.6) });

  const rightX = marginX + colW + 40;
  page.drawText(`От «${market.name}»:`, { x: rightX, y: cursorY, size: 9, font: boldFont });
  page.drawText('Главный бухгалтер: ___________________', { x: rightX, y: cursorY - 18, size: 8.5, font: regularFont });
  page.drawText('М.П.', { x: rightX + 160, y: cursorY - 40, size: 10, font: boldFont, color: rgb(0.6, 0.6, 0.6) });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
