import type { Api } from 'grammy';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface CompanyRequisites {
  companyName?: string | null;
  inn?: string | null;
  account?: string | null;
  bankName?: string | null;
  mfo?: string | null;
  director?: string | null;
  address?: string | null;
}

/**
 * Скачать файл из Telegram по file_id в виде Buffer
 */
export async function downloadTelegramFile(api: Api, fileId: string): Promise<{ buffer: Buffer; filePath: string }> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram не вернул путь к файлу');

  const url = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Ошибка скачивания файла из Telegram: HTTP ${res.status}`);

  const arr = await res.arrayBuffer();
  return { buffer: Buffer.from(arr), filePath: file.file_path };
}

/**
 * Расшифровка голосового сообщения (Voice-to-Text) через Gemini Audio
 */
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
    passportNumber: { type: 'STRING', nullable: true, description: 'Серия и номер паспорта или ID-карты (например, FA 1234567, AA 1234567)' },
  },
};

/**
 * Извлечение реквизитов из PDF или изображения через Gemini Multimodal
 */
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
