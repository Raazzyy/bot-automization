import type { Api } from 'grammy';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface CompanyRequisites {
  documentType?: string | null;
  companyName?: string | null;
  inn?: string | null;
  account?: string | null;
  bankName?: string | null;
  mfo?: string | null;
  director?: string | null;
  address?: string | null;
  pinfl?: string | null;
  passportNumber?: string | null;
}

export async function downloadTelegramFile(api: Api, fileId: string): Promise<{ buffer: Buffer; filePath: string }> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram не вернул путь к файлу');

  const url = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Ошибка скачивания файла из Telegram: HTTP ${res.status}`);

  const arr = await res.arrayBuffer();
  return { buffer: Buffer.from(arr), filePath: file.file_path };
}

export async function transcribeAudio(buffer: Buffer, mimeType = 'audio/ogg'): Promise<string> {
  if (!config.GEMINI_API_KEY) return '';

  const base64 = buffer.toString('base64');
  const prompt = `
Ты профессиональный транскрибатор речи в текст для бизнеса в Узбекистане.
В аудиозаписи клиент оптовой компании AKM Holdings говорит на узбекском или русском языке (или на смеси).
Расшифруй сказанное точно и дословно слово в слово.
Если клиент диктует заказ (товары, количество, юрлица, время) — передай все названия и цифры точно.
Верни ТОЛЬКО расшифрованный текст, без каких-либо пояснений или предисловий.
`.trim();

  try {
    const res = await fetch(
      `${BASE}/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64,
                  },
                },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        }),
        signal: AbortSignal.timeout(35_000),
      },
    );

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      error?: { message?: string };
    };

    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return text.trim();
  } catch (e) {
    log.warn('Ошибка расшифровки аудио через Gemini', (e as Error).message);
    return '';
  }
}

const REQUISITES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    documentType: { type: 'STRING', nullable: true, description: 'Тип документа: гувохнома, справка_банк, паспорт_или_id, счет_фактура, договор, ндс_гувохнома' },
    companyName: { type: 'STRING', nullable: true, description: 'Название компании, ООО, ИП, MCHJ (если есть)' },
    inn: { type: 'STRING', nullable: true, description: 'ИНН организации или физического лица (обычно 9 цифр)' },
    account: { type: 'STRING', nullable: true, description: 'Расчетный счет (20 цифр, обычно начинается на 20208...)' },
    bankName: { type: 'STRING', nullable: true, description: 'Название банка' },
    mfo: { type: 'STRING', nullable: true, description: 'МФО банка (5 цифр)' },
    director: { type: 'STRING', nullable: true, description: 'ФИО руководителя, директора или гражданина' },
    address: { type: 'STRING', nullable: true, description: 'Адрес регистрации организации или гражданина' },
    pinfl: { type: 'STRING', nullable: true, description: 'ПИНФЛ / ЖШШИР (14 цифр физлица в паспорте или ID карте)' },
    passportNumber: { type: 'STRING', nullable: true, description: 'Серия и номер паспорта или ID-карты' },
  },
};

export async function extractRequisitesFromMedia(
  buffer: Buffer,
  mimeType: string,
): Promise<CompanyRequisites | null> {
  if (!config.GEMINI_API_KEY) return null;

  const base64 = buffer.toString('base64');
  const prompt = `
Ты опытный бухгалтерский и юридический эксперт по документообороту в Узбекистане.
Перед тобой реальный документ от клиента:
- Гувохнома (свидетельство о государственной регистрации ООО / MCHJ / ИП)
- Справка из банка / справка о кассе (счет 20208..., МФО банка 5 цифр, наименование банка)
- Паспорт или ID-карта гражданина/директора (ФИО, серия и номер паспорта, 14-значный ПИНФЛ)
- Электронная счет-фактура (Ҳисоб-фактура / ЭСФ) или договор
- Свидетельство плательщика НДС

Извлеки все имеющиеся реквизиты.
Ответь строго в JSON по схеме.
`.trim();

  try {
    const res = await fetch(
      `${BASE}/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64,
                  },
                },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
            responseSchema: REQUISITES_SCHEMA,
          },
        }),
        signal: AbortSignal.timeout(35_000),
      },
    );

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      error?: { message?: string };
    };

    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    const raw = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!raw.trim()) return null;

    const parsed = JSON.parse(raw) as Partial<CompanyRequisites>;
    if (
      !parsed.inn &&
      !parsed.companyName &&
      !parsed.account &&
      !parsed.passportNumber &&
      !parsed.pinfl &&
      !parsed.director
    ) {
      return null;
    }

    return {
      documentType: parsed.documentType ?? null,
      companyName: parsed.companyName ?? null,
      inn: parsed.inn ?? null,
      account: parsed.account ?? null,
      bankName: parsed.bankName ?? null,
      mfo: parsed.mfo ?? null,
      director: parsed.director ?? null,
      address: parsed.address ?? null,
      pinfl: parsed.pinfl ?? null,
      passportNumber: parsed.passportNumber ?? null,
    };
  } catch (e) {
    log.warn('Ошибка извлечения реквизитов через Gemini', (e as Error).message);
    return null;
  }
}

export interface RecognizedOrderItem {
  productName: string;
  amount: number;
  unit?: string;
  comment?: string;
}

export interface PhotoOrderResult {
  isOrder: boolean;
  items: RecognizedOrderItem[];
  rawSummary: string;
  notes?: string;
}

const ORDER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isOrder: { type: 'BOOLEAN', description: 'Является ли изображение заявкой, списком товаров, накладной или чеком заказа' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          productName: { type: 'STRING', description: 'Наименование товара' },
          amount: { type: 'NUMBER', description: 'Количество' },
          unit: { type: 'STRING', nullable: true, description: 'Единица измерения (шт, кор, блок, кг, банка)' },
          comment: { type: 'STRING', nullable: true, description: 'Дополнительные пометки' },
        },
        required: ['productName', 'amount'],
      },
    },
    rawSummary: { type: 'STRING', description: 'Краткий читаемый текст всего заказа' },
    notes: { type: 'STRING', nullable: true, description: 'Заметки по доставке или контактам, если есть' },
  },
  required: ['isOrder', 'items', 'rawSummary'],
};

export async function extractOrderFromPhoto(
  buffer: Buffer,
  mimeType = 'image/jpeg',
): Promise<PhotoOrderResult | null> {
  if (!config.GEMINI_API_KEY) return null;

  const base64 = buffer.toString('base64');
  const prompt = `
Ты эксперт по распознаванию заказов для дистрибьютора продуктов питания в Ташкенте.
Клиент прислал фото:
- Рукописная записка повара/шефа или закупщика на бумаге или салфетке (на русском или узбекском языках)
- Напечатанный бланк заказа, товарный чек или накладная
- Список позиций с указанием количества

Твоя задача:
1. Проверить, содержит ли фото заявку на товары (isOrder).
2. Распознать все позиции, количество и единицы измерения (шт, коробки, банки, блоки, кг).
3. Перевести сокращения в читаемый вид (например: «тунец 160» -> «Тунец 160г», «маслины б/к» -> «Маслины без косточки», «уксус наре» -> «Уксус Nare»).
4. Сформировать понятный текст заказа в rawSummary (например: «Тунец 160г — 2 кор., Маслины — 4 банки»).

Ответь строго в формате JSON по схеме.
`.trim();

  try {
    const res = await fetch(
      `${BASE}/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64,
                  },
                },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
            responseSchema: ORDER_SCHEMA,
          },
        }),
        signal: AbortSignal.timeout(35_000),
      },
    );

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      error?: { message?: string };
    };

    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    const raw = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!raw.trim()) return null;

    const parsed = JSON.parse(raw) as PhotoOrderResult;
    if (!parsed.isOrder || !parsed.items || parsed.items.length === 0) {
      return null;
    }

    return parsed;
  } catch (e) {
    log.warn('Ошибка распознавания заказа с фото через Gemini', (e as Error).message);
    return null;
  }
}
