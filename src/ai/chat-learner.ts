import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

export interface ExtractedAlias {
  clientPhrase: string;
  formalProduct: string;
  notes?: string;
}

export interface GoldenDialogue {
  clientQuestion: string;
  managerAnswer: string;
  topic: string;
}

export interface ClientProfile {
  clientName: string;
  typicalProducts: string[];
  orderFrequency?: string;
  paymentHabit?: string;
  notes?: string;
}

export interface LearnedKnowledge {
  version: string;
  lastUpdated: string;
  totalAnalyzedMessages: number;
  totalClients: number;
  extractedAliases: ExtractedAlias[];
  goldenDialogues: GoldenDialogue[];
  clientProfiles: ClientProfile[];
  businessInsights: string[];
}

const LEARNED_FILE_PATH = path.resolve('src/ai/learned-knowledge.json');

export function loadLearnedKnowledge(): LearnedKnowledge | null {
  try {
    if (!fs.existsSync(LEARNED_FILE_PATH)) return null;
    const content = fs.readFileSync(LEARNED_FILE_PATH, 'utf8');
    return JSON.parse(content) as LearnedKnowledge;
  } catch (e) {
    log.warn('Не удалось загрузить learned-knowledge.json', (e as Error).message);
    return null;
  }
}

export function saveLearnedKnowledge(data: LearnedKnowledge): void {
  fs.writeFileSync(LEARNED_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

export function parseTelegramHtmlMessages(htmlContent: string): Array<{ sender: string; text: string; date?: string }> {
  const re = /<div class="from_name">\s*([\s\S]*?)\s*<\/div>[\s\S]*?<div class="text">\s*([\s\S]*?)\s*<\/div>/g;
  const messages: Array<{ sender: string; text: string; date?: string }> = [];
  let m;

  while ((m = re.exec(htmlContent)) !== null) {
    const sender = (m[1] ?? '').replace(/<[^>]+>/g, '').trim();
    const text = (m[2] ?? '').replace(/<[^>]+>/g, '').trim();
    if (text && text.length > 1) {
      messages.push({ sender, text });
    }
  }

  return messages;
}

export async function analyzeDialogueBatch(
  clientName: string,
  messages: Array<{ sender: string; text: string }>,
): Promise<{
  aliases: ExtractedAlias[];
  dialogues: GoldenDialogue[];
  profile: ClientProfile;
  insights: string[];
}> {
  if (!config.GEMINI_API_KEY) {
    return { aliases: [], dialogues: [], profile: { clientName, typicalProducts: [] }, insights: [] };
  }

  const transcript = messages.map((m) => `${m.sender}: ${m.text}`).join('\n');

  const prompt = `
Ты старший бизнес-аналитик и тренер ИИ для B2B дистрибьютора продуктов питания в Узбекистане (FMCG/HoReCa).
Компания: AKM Distribution (дистрибьютор Dardanel, Burcu, Sayam).
Клиент: "${clientName}".

Перед тобой фрагмент реальной переписки между клиентом и оптовым менеджером:
"""
${transcript}
"""

Извлеки максимум практической пользы для обучения ИИ-бота:
1. Сленговые или разговорные названия товаров, граммовки (например, "160 грамовый" -> "Тунец Dardanel 160г").
2. Лучшие образцы ответов менеджера (отработка вопросов о ценах, доставке, долге, минимальном заказе).
3. Профиль заведения (какие товары чаще всего заказывает этот клиент, особенности работы с ним).
4. Бизнес-инсайты (напоминания об оплате, условия отгрузки, специфика HoReCa).

Ответь строго в формате JSON по схеме:
{
  "aliases": [
    { "clientPhrase": "...", "formalProduct": "...", "notes": "..." }
  ],
  "dialogues": [
    { "clientQuestion": "...", "managerAnswer": "...", "topic": "..." }
  ],
  "profile": {
    "clientName": "${clientName}",
    "typicalProducts": ["..."],
    "orderFrequency": "...",
    "paymentHabit": "...",
    "notes": "..."
  },
  "insights": ["..."]
}
`.trim();

  const BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const res = await fetch(`${BASE}/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ошибка Gemini API: HTTP ${res.status}`);
  }

  const json = (await res.json()) as any;
  const rawText = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

  try {
    const parsed = JSON.parse(rawText);
    return {
      aliases: parsed.aliases || [],
      dialogues: parsed.dialogues || [],
      profile: parsed.profile || { clientName, typicalProducts: [] },
      insights: parsed.insights || [],
    };
  } catch (err) {
    log.warn('Ошибка парсинга ответа анализатора чатов', (err as Error).message);
    return { aliases: [], dialogues: [], profile: { clientName, typicalProducts: [] }, insights: [] };
  }
}

export function formatFewShotForSystemPrompt(): string {
  const data = loadLearnedKnowledge();
  if (!data || data.goldenDialogues.length === 0) return '';

  const examples = data.goldenDialogues.slice(0, 6).map((d, idx) => {
    return `${idx + 1}. Вопрос клиента: «${d.clientQuestion}»\n   Твой эталонный ответ: «${d.managerAnswer}» (Тема: ${d.topic})`;
  }).join('\n\n');

  const aliases = data.extractedAliases.slice(0, 8).map((a) => {
    return `• «${a.clientPhrase}» означает «${a.formalProduct}»${a.notes ? ` (${a.notes})` : ''}`;
  }).join('\n');

  return `
ОБУЧЕНО НА РЕАЛЬНЫХ ПЕРЕПИСКАХ КОМПАНИИ:
${aliases ? `\nСловарь разговорных названий клиентов:\n${aliases}\n` : ''}
${examples ? `\nЗолотые стандарты ответов менеджеров:\n${examples}\n` : ''}
`.trim();
}

export function findClientProfile(query: { clientName?: string | null; marketName?: string | null }): ClientProfile | null {
  const data = loadLearnedKnowledge();
  if (!data || !data.clientProfiles || data.clientProfiles.length === 0) return null;

  const qName = (query.clientName || '').toLowerCase().trim();
  const qMarket = (query.marketName || '').toLowerCase().trim();

  if (!qName && !qMarket) return null;

  for (const profile of data.clientProfiles) {
    const pName = profile.clientName.toLowerCase().trim();
    if (qName && (pName.includes(qName) || qName.includes(pName))) {
      return profile;
    }
    if (qMarket && (pName.includes(qMarket) || qMarket.includes(pName))) {
      return profile;
    }
    if (profile.notes && ((qName && profile.notes.toLowerCase().includes(qName)) || (qMarket && profile.notes.toLowerCase().includes(qMarket)))) {
      return profile;
    }
  }

  return null;
}

const CORRECTIONS_FILE = path.resolve('src/ai/manager-feedback.json');

export interface ManagerFeedbackEntry {
  timestamp: string;
  chatId: number;
  clientName?: string;
  clientText: string;
  botDraft?: string;
  managerActualText: string;
}

export function recordManagerFeedback(entry: Omit<ManagerFeedbackEntry, 'timestamp'>): void {
  try {
    let list: ManagerFeedbackEntry[] = [];
    if (fs.existsSync(CORRECTIONS_FILE)) {
      list = JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
    }
    list.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
    fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(list.slice(-500), null, 2), 'utf8');
    log.info(`Записана правка менеджера для чата ${entry.chatId} (всего: ${list.length})`);
  } catch (e) {
    log.warn('Не удалось записать правку менеджера', (e as Error).message);
  }
}
