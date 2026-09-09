import { config } from '../config.js';
import { log } from '../lib/logger.js';

/**
 * Разбор свободного текста клиента в структуру.
 *
 * Здесь модель НИЧЕГО не решает и никому не отвечает — она только
 * раскладывает сообщение по полочкам, чтобы менеджер увидел аккуратную
 * карточку вместо простыни. Если разбор не удался, показываем как есть:
 * потерять сообщение хуже, чем показать его сырым.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface ExtractedItem {
  /** Название так, как написал клиент */
  name: string;
  /** Количество, если названо */
  qty: number | null;
  /** Единица: шт, кг, коробка, мешок… */
  unit: string | null;
}

export interface ExtractedEntity {
  /** Юрлицо или точка, если клиент их разделил */
  entity: string | null;
  items: ExtractedItem[];
}

export interface Extracted {
  /** Похоже ли сообщение на заказ */
  isOrder: boolean;
  /** Заказ, разложенный по юрлицам */
  orders: ExtractedEntity[];
  /** Вопросы, не относящиеся к заказу */
  questions: string[];
  /** Про документы, договоры, счета, оплату */
  aboutDocuments: boolean;
  /** Одна строка сути — для заголовка карточки */
  summary: string;
}

const EMPTY: Extracted = {
  isOrder: false, orders: [], questions: [],
  aboutDocuments: false, summary: '',
};

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    isOrder: { type: 'BOOLEAN' },
    orders: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          entity: { type: 'STRING', nullable: true },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                qty: { type: 'NUMBER', nullable: true },
                unit: { type: 'STRING', nullable: true },
              },
              required: ['name'],
            },
          },
        },
        required: ['items'],
      },
    },
    questions: { type: 'ARRAY', items: { type: 'STRING' } },
    aboutDocuments: { type: 'BOOLEAN' },
    summary: { type: 'STRING' },
  },
  required: ['isOrder', 'orders', 'questions', 'aboutDocuments', 'summary'],
};

const INSTRUCTION = `
Ты разбираешь сообщение оптового клиента и раскладываешь его по полям.
Ты НЕ отвечаешь клиенту и ничего не решаешь — только структурируешь.

Правила:
- isOrder: true, только если клиент просит отгрузить товар.
  Вопрос «а есть ли у вас…» — это НЕ заказ, это вопрос.
- orders: если клиент заказывает на несколько юрлиц или точек, раздели их.
  Один человек часто заказывает сразу на две фирмы — не смешивай позиции.
  Названия юрлиц пиши так, как написал клиент: «Basilic», «ООО Sakura City».
- qty и unit заполняй, только если клиент их назвал. Не додумывай.
- questions: всё, что клиент спросил, кроме самого заказа. Дословно и коротко.
- aboutDocuments: true, если речь о договоре, спецификации, доверенности,
  счёте, ЭСФ, Дедоксе, реквизитах, оплате, предоплате, пакете документов.
- summary: одна короткая строка по-русски, суть сообщения.
  Например «Заказ: тунец 48 шт на две фирмы» или «Спрашивает про наличие сельди».

Отвечай строго в JSON по схеме.
`.trim();

export async function extractRequest(text: string): Promise<Extracted> {
  if (!config.GEMINI_API_KEY || !text.trim()) return { ...EMPTY, summary: text.slice(0, 80) };

  try {
    const res = await fetch(
      `${BASE}/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text }] }],
          systemInstruction: { parts: [{ text: INSTRUCTION }] },
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
            responseSchema: SCHEMA,
            thinkingConfig: { thinkingLevel: 'low' },
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      error?: { message?: string };
    };

    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);

    const raw = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!raw.trim()) throw new Error('пустой ответ');

    const parsed = JSON.parse(raw) as Partial<Extracted>;

    return {
      isOrder: parsed.isOrder ?? false,
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      aboutDocuments: parsed.aboutDocuments ?? false,
      summary: parsed.summary || text.slice(0, 80),
    };
  } catch (e) {
    // Разбор не удался — не беда, менеджер увидит исходный текст
    log.warn('Разбор сообщения не удался, покажу как есть', (e as Error).message);
    return { ...EMPTY, summary: text.slice(0, 80) };
  }
}
