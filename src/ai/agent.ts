import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { TOOL_DECLARATIONS, callTool, listMedia, type ToolContext } from './tools.js';
import { SYSTEM_CHANNEL_A, SYSTEM_CHANNEL_B, buildContext, detectLang } from './prompt.js';

/**
 * Клиент Gemini поверх REST — без SDK.
 * Причина простая: у REST стабильный контракт, а SDK меняет сигнатуры
 * от версии к версии и тянет зависимости, которые тут не нужны.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface Part {
  text?: string;
  /** Модели Gemini 3.x возвращают подпись рассуждения и id вызова.
   *  Их обязательно вернуть обратно вместе с functionCall, иначе API даёт 400. */
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
}
interface Content { role: 'user' | 'model'; parts: Part[] }

interface GenerateResponse {
  candidates?: { content?: Content; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export interface AgentTurn {
  /** Что сказать клиенту. Пустая строка — сказать нечего. */
  reply: string;
  /** Какие инструменты вызывались — для лога и разбора */
  toolCalls: { name: string; args: Record<string, unknown>; result: string }[];
  /** Нужен человек */
  handoff?: string;
  /** Ключи файлов, которые надо приложить к ответу */
  attachments: string[];
  error?: string;
}

export interface AgentInput {
  message: string;
  channel: 'A' | 'B';
  ctx: ToolContext;
  clientName?: string | null;
  marketName?: string | null;
  lastOrderDate?: string | null;
  /** Предыдущие реплики: [роль, текст] */
  history?: { role: 'user' | 'model'; text: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generate(body: unknown, attempt = 1): Promise<GenerateResponse> {
  const url = `${BASE}/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });

  const json = (await res.json()) as GenerateResponse;

  if (!res.ok) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;

    // Бесплатный тариф — 15 запросов в минуту. Сервер сам говорит,
    // сколько ждать; ждём и повторяем, вместо того чтобы падать.
    if (res.status === 429 && attempt <= 2) {
      const m = /retry in ([0-9.]+)s/i.exec(msg);
      const waitMs = Math.min(Math.ceil(Number(m?.[1] ?? 30)) + 2, 70) * 1000;
      log.warn(`Gemini: лимит запросов, жду ${Math.round(waitMs / 1000)} с и повторяю`);
      await sleep(waitMs);
      return generate(body, attempt + 1);
    }

    const hint =
      res.status === 429 ? ' — упёрлись в бесплатный лимит, подождите минуту'
      : res.status === 400 && /API key/i.test(msg) ? ' — проверьте GEMINI_API_KEY'
      : res.status === 404 ? ` — модель «${config.GEMINI_MODEL}» недоступна, посмотрите список: npm run models`
      : '';
    throw new Error(msg + hint);
  }

  return json;
}

/**
 * Модель регулярно ОБЕЩАЕТ передать менеджеру, но инструмент не вызывает.
 * Для клиента это худший исход: ему сказали «сейчас подключу человека»,
 * а человек ничего не узнал. Полагаться тут на модель нельзя — ловим кодом.
 */
const PROMISED_HANDOFF = /(переда(ю|м|ст)|подключ(у|им|ит)|уточн(ю|им)|позов(у|ём)|свяж(усь|ется)|менеджер|коллег|сотрудник|специалист)/i;

function looksLikeHandoffPromise(reply: string): boolean {
  return PROMISED_HANDOFF.test(reply);
}

/** Один ход разговора: вопрос клиента → ответ, с вызовами инструментов по пути */
export async function runAgent(input: AgentInput): Promise<AgentTurn> {
  if (!config.GEMINI_API_KEY) {
    return { reply: '', toolCalls: [], attachments: [], error: 'GEMINI_API_KEY не задан' };
  }

  const system = (input.channel === 'A' ? SYSTEM_CHANNEL_A : SYSTEM_CHANNEL_B)
    + '\n\n'
    + buildContext({
      // Без этого списка модель не знает, какие файлы существуют,
      // и вызвать otpravit_fayl ей просто нечем — ключи она не выдумывает.
      media: await listMedia(),
      clientName: input.clientName,
      marketName: input.marketName,
      marketId: input.ctx.marketId,
      lastOrderDate: input.lastOrderDate,
      lang: detectLang(input.message),
    });

  const contents: Content[] = [
    ...(input.history ?? []).map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user' as const, parts: [{ text: input.message }] },
  ];

  const toolCalls: AgentTurn['toolCalls'] = [];
  const attachments: string[] = [];
  let handoff: string | undefined;

  // До 5 раундов: модель может несколько раз сходить в инструменты подряд
  for (let round = 0; round < 5; round++) {
    let res: GenerateResponse;
    try {
      res = await generate({
        contents,
        systemInstruction: { parts: [{ text: system }] },
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        generationConfig: {
          // Низкая температура: от прогона к прогону ответы должны быть
          // одинаковыми. Творчество здесь не нужно, нужна предсказуемость.
          temperature: 0.15,
          // Щедрый лимит: у Gemini 3.x «размышления» тратят тот же бюджет,
          // и при 600 модель успевала подумать, но не ответить.
          maxOutputTokens: 2048,
          // Нам не нужны длинные рассуждения — нужен быстрый короткий ответ.
          thinkingConfig: { thinkingLevel: 'low' },
        },
      });
    } catch (e) {
      log.error('Gemini не ответил', (e as Error).message);
      return { reply: '', toolCalls, attachments, error: (e as Error).message };
    }

    if (res.promptFeedback?.blockReason) {
      return { reply: '', toolCalls, attachments, error: `запрос заблокирован: ${res.promptFeedback.blockReason}` };
    }

    const modelContent = res.candidates?.[0]?.content;
    const parts = modelContent?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);

    if (!calls.length) {
      const text = parts.map((p) => p.text ?? '').join('').trim();

      // Пообещала человека, но инструмент не вызвала — считаем передачей всё равно
      if (!handoff && looksLikeHandoffPromise(text)) {
        log.warn('Модель пообещала менеджера, но не вызвала инструмент — передаю принудительно');
        handoff = 'модель пообещала передать менеджеру';
      }

      return { reply: text, toolCalls, attachments, handoff };
    }

    // Ответ модели кладём в историю КАК ЕСТЬ: вместе с thoughtSignature
    // и id вызова. Пересобирать его нельзя — Gemini 3.x вернёт 400.
    contents.push(modelContent as Content);

    const responses: Part[] = [];
    for (const p of calls) {
      const fc = p.functionCall!;
      const r = await callTool(fc.name, fc.args ?? {}, input.ctx);
      toolCalls.push({ name: fc.name, args: fc.args ?? {}, result: r.data });
      if (r.handoff) handoff = r.handoff;
      if (r.sendFile && !attachments.includes(r.sendFile)) attachments.push(r.sendFile);
      log.debug(`инструмент ${fc.name}`, { args: fc.args, ok: r.ok });
      responses.push({
        functionResponse: {
          name: fc.name,
          response: { result: r.data },
          ...(fc.id ? { id: fc.id } : {}),
        },
      });
    }
    contents.push({ role: 'user', parts: responses });
  }

  return {
    reply: '',
    toolCalls,
    attachments,
    handoff: handoff ?? 'модель зациклилась на инструментах',
    error: 'превышено число раундов',
  };
}

/** Список моделей, доступных этому ключу */
export async function listModels(): Promise<{ name: string; methods: string[] }[]> {
  const res = await fetch(`${BASE}/models?key=${config.GEMINI_API_KEY}&pageSize=100`);
  const j = (await res.json()) as {
    models?: { name: string; supportedGenerationMethods?: string[] }[];
    error?: { message: string };
  };
  if (!res.ok) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
  return (j.models ?? []).map((m) => ({
    name: m.name.replace('models/', ''),
    methods: m.supportedGenerationMethods ?? [],
  }));
}
