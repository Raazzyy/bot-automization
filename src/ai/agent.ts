import { config } from '../config.js';
import { log } from '../lib/logger.js';
import { getAllSettings } from '../lib/settings.js';
import { TOOL_DECLARATIONS, callTool, listMedia, type ToolContext } from './tools.js';
import { getSystemPromptA, getSystemPromptB, buildContext, detectLang } from './prompt.js';
import { findClientProfile } from './chat-learner.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface Part {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
}

interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

interface GenerateResponse {
  candidates?: { content?: Content; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export interface AgentTurn {
  reply: string;
  toolCalls: { name: string; args: Record<string, unknown>; result: string }[];
  handoff?: string;
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
  history?: { role: 'user' | 'model'; text: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generate(
  body: unknown,
  attempt = 1,
  opts?: { apiKey?: string; model?: string },
): Promise<GenerateResponse> {
  const activeKey = opts?.apiKey || config.GEMINI_API_KEY;
  const activeModel = opts?.model || config.GEMINI_MODEL;
  const url = `${BASE}/models/${activeModel}:generateContent?key=${activeKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });

  const json = (await res.json()) as GenerateResponse;

  if (!res.ok) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;

    if (res.status === 429 && attempt <= 2) {
      const m = /retry in ([0-9.]+)s/i.exec(msg);
      const waitMs = Math.min(Math.ceil(Number(m?.[1] ?? 30)) + 2, 70) * 1000;
      log.warn(`Gemini: лимит запросов, ожидание ${Math.round(waitMs / 1000)} с`);
      await sleep(waitMs);
      return generate(body, attempt + 1, opts);
    }

    const hint =
      res.status === 429 ? ' — лимит запросов, повторите через минуту'
      : res.status === 400 && /API key/i.test(msg) ? ' — проверьте GEMINI_API_KEY'
      : res.status === 404 ? ` — модель ${activeModel} недоступна`
      : '';
    throw new Error(msg + hint);
  }

  return json;
}

const PROMISED_HANDOFF = /(переда(ю|м|ст)|подключ(у|им|ит)|уточн(ю|им)|позов(у|ём)|свяж(усь|ется)|менеджер|коллег|сотрудник|специалист)/i;

function looksLikeHandoffPromise(reply: string): boolean {
  return PROMISED_HANDOFF.test(reply);
}

export async function runAgent(input: AgentInput): Promise<AgentTurn> {
  const settings = await getAllSettings();
  const apiKey = settings.gemini_api_key || config.GEMINI_API_KEY;
  const model = settings.gemini_model || config.GEMINI_MODEL;

  if (!apiKey) {
    return { reply: '', toolCalls: [], attachments: [], error: 'GEMINI_API_KEY не задан' };
  }

  const clientProfile = findClientProfile({
    clientName: input.clientName,
    marketName: input.marketName,
  });

  const isNewClient = !clientProfile && !input.ctx.marketId && !input.lastOrderDate && (!input.history || input.history.length === 0);

  const baseSystem = input.channel === 'A' ? await getSystemPromptA(settings) : await getSystemPromptB(settings);
  const system = baseSystem
    + '\n\n'
    + buildContext({
      media: await listMedia(),
      clientName: input.clientName,
      marketName: input.marketName,
      marketId: input.ctx.marketId,
      lastOrderDate: input.lastOrderDate,
      lang: detectLang(input.message),
      clientProfile,
      isNewClient,
    });

  const contents: Content[] = [
    ...(input.history ?? []).map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: 'user' as const, parts: [{ text: input.message }] },
  ];

  const toolCalls: AgentTurn['toolCalls'] = [];
  const attachments: string[] = [];
  let handoff: string | undefined;

  for (let round = 0; round < 5; round++) {
    let res: GenerateResponse;
    try {
      res = await generate({
        contents,
        systemInstruction: { parts: [{ text: system }] },
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingLevel: 'low' },
        },
      }, 1, { apiKey, model });
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

      if (!handoff && looksLikeHandoffPromise(text)) {
        handoff = 'модель пообещала передать менеджеру';
      }

      return { reply: text, toolCalls, attachments, handoff };
    }

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
