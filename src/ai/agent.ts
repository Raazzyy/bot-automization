import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { TOOL_DECLARATIONS, callTool, type ToolContext } from './tools.js';
import { SYSTEM_CHANNEL_A, SYSTEM_CHANNEL_B, buildContext } from './prompt.js';

/**
 * Клиент Gemini поверх REST — без SDK.
 * Причина простая: у REST стабильный контракт, а SDK меняет сигнатуры
 * от версии к версии и тянет зависимости, которые тут не нужны.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface Part {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
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

async function generate(body: unknown): Promise<GenerateResponse> {
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
    const hint =
      res.status === 429 ? ' — упёрлись в бесплатный лимит, подождите минуту'
      : res.status === 400 && /API key/i.test(msg) ? ' — проверьте GEMINI_API_KEY'
      : res.status === 404 ? ` — модель «${config.GEMINI_MODEL}» недоступна, посмотрите список: npm run models`
      : '';
    throw new Error(msg + hint);
  }

  return json;
}

/** Один ход разговора: вопрос клиента → ответ, с вызовами инструментов по пути */
export async function runAgent(input: AgentInput): Promise<AgentTurn> {
  if (!config.GEMINI_API_KEY) {
    return { reply: '', toolCalls: [], error: 'GEMINI_API_KEY не задан' };
  }

  const system = (input.channel === 'A' ? SYSTEM_CHANNEL_A : SYSTEM_CHANNEL_B)
    + '\n\n'
    + buildContext({
      clientName: input.clientName,
      marketName: input.marketName,
      marketId: input.ctx.marketId,
      lastOrderDate: input.lastOrderDate,
    });

  const contents: Content[] = [
    ...(input.history ?? []).map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user' as const, parts: [{ text: input.message }] },
  ];

  const toolCalls: AgentTurn['toolCalls'] = [];
  let handoff: string | undefined;

  // До 5 раундов: модель может несколько раз сходить в инструменты подряд
  for (let round = 0; round < 5; round++) {
    let res: GenerateResponse;
    try {
      res = await generate({
        contents,
        systemInstruction: { parts: [{ text: system }] },
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
      });
    } catch (e) {
      log.error('Gemini не ответил', (e as Error).message);
      return { reply: '', toolCalls, error: (e as Error).message };
    }

    if (res.promptFeedback?.blockReason) {
      return { reply: '', toolCalls, error: `запрос заблокирован: ${res.promptFeedback.blockReason}` };
    }

    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall!);

    if (!calls.length) {
      const text = parts.map((p) => p.text ?? '').join('').trim();
      return { reply: text, toolCalls, handoff };
    }

    // Модель просит инструменты — выполняем и возвращаем результаты
    contents.push({ role: 'model', parts: calls.map((fc) => ({ functionCall: fc })) });

    const responses: Part[] = [];
    for (const fc of calls) {
      const r = await callTool(fc.name, fc.args ?? {}, input.ctx);
      toolCalls.push({ name: fc.name, args: fc.args ?? {}, result: r.data });
      if (r.handoff) handoff = r.handoff;
      log.debug(`инструмент ${fc.name}`, { args: fc.args, ok: r.ok });
      responses.push({ functionResponse: { name: fc.name, response: { result: r.data } } });
    }
    contents.push({ role: 'user', parts: responses });
  }

  return {
    reply: '',
    toolCalls,
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
