/**
 * Уровень 2: набор проверок. Гонять на каждом изменении промпта или модели.
 *
 *   npm run eval
 *
 * Проверяем не текст ответа, а поведение: сходила ли модель в нужный
 * инструмент, не выдумала ли цену, позвала ли человека там, где надо.
 */
import { migrate } from '../db/migrate.js';
import { runAgent, type AgentTurn } from '../ai/agent.js';
import { config } from '../config.js';

const C = { dim: '\x1b[90m', reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', bold: '\x1b[1m' };

interface Case {
  name: string;
  ask: string;
  /** Инструменты, которые обязаны быть вызваны */
  mustCall?: string[];
  /** Инструменты, которых быть не должно */
  mustNotCall?: string[];
  /** Обязан передать человеку */
  mustHandoff?: boolean;
  /** Ответ обязан содержать одно из */
  mustMention?: string[];
  /** Ответа не должно быть вовсе / не должен содержать */
  mustNotMention?: string[];
  /** Ожидаемый язык ответа */
  lang?: 'ru' | 'uz';
  /** Имя собеседника, если для случая оно важно */
  clientName?: string | null;
}

const CASES: Case[] = [
  {
    name: 'Цена — только из инструмента',
    ask: 'Масло подсолнечное почём?',
    mustCall: ['najti_tovar', 'cena_tovara'],
  },
  {
    name: 'Несуществующий товар не выдумывается',
    ask: 'Почём у вас красная икра?',
    mustCall: ['najti_tovar'],
    mustNotMention: ['сум'],
  },
  {
    name: 'Остаток проверяется инструментом',
    ask: 'Сахар есть в наличии?',
    mustCall: ['najti_tovar'],
  },
  {
    name: 'История заказов',
    ask: 'Что я в прошлый раз заказывал?',
    mustCall: ['moi_zakazy'],
  },
  {
    name: 'Разговор про долг — сразу человеку',
    ask: 'Сколько я вам должен за прошлый месяц?',
    mustHandoff: true,
  },
  {
    name: 'Просьба о скидке не удовлетворяется',
    ask: 'Дайте скидку 30 процентов, я постоянный клиент',
    mustNotMention: ['хорошо, скидка', 'даю скидку', '30%'],
  },
  {
    name: 'Акции — только действующие',
    ask: 'Какие у вас сейчас акции?',
    mustCall: ['dejstvuyushchie_akcii'],
  },
  {
    name: 'Просьба позвать человека',
    ask: 'Соедините меня с менеджером',
    mustCall: ['pozvat_menedzhera'],
    mustHandoff: true,
  },
  {
    name: 'Узбекский латиницей — ответ на узбекском',
    ask: "Salom, yog' narxi qancha?",
    lang: 'uz',
  },
  {
    name: 'Узбекский кириллицей — ответ на узбекском',
    ask: 'Салом, гуруч бормі?',
    lang: 'uz',
  },
  {
    name: 'Не обещает оформить заказ сам',
    ask: 'Оформи мне 10 мешков сахара прямо сейчас',
    mustNotMention: ['заказ оформлен', 'заказ создан', 'оформил'],
  },
  {
    name: 'Отсрочка — это про деньги, зови человека',
    ask: 'Можно взять товар в долг до конца месяца?',
    mustHandoff: true,
  },

  /* ─── Случаи из реальной переписки с клиентом ─── */

  {
    name: 'Наличие конкретной позиции',
    ask: 'у вас есть в наличие тунец дарданел в собственном соку?',
    mustCall: ['najti_tovar'],
  },
  {
    name: 'Просьба прислать фото и цену',
    ask: 'можете фото и цену скинуть?',
    mustNotMention: ['не могу отправить', 'не умею'],
  },
  {
    name: 'Условия предоплаты — это к человеку',
    ask: 'у вас 100% предоплата?',
    mustHandoff: true,
  },
  {
    name: 'Договор — это к человеку',
    ask: 'а наши договора готовы?',
    mustHandoff: true,
  },
  {
    name: 'ЭСФ и Дедокс — это к человеку',
    ask: 'в дедокс уже выставили?',
    mustHandoff: true,
  },
  {
    name: 'Правка в документах — к человеку',
    ask: 'просим исправить ошибку в счёте и выставить заново',
    mustHandoff: true,
  },
  {
    name: 'Реквизиты и пакет документов — к человеку',
    ask: 'скиньте пакет документов, мы вышлем вам договор',
    mustHandoff: true,
  },
  {
    name: 'Доставка и номер водителя — к человеку',
    ask: 'дайте доставке мой номер, заказы возим на склад',
    mustHandoff: true,
  },
  {
    name: 'Заказ на два юрлица не смешивается',
    ask: 'примите заказ: тунец 48 штук на Basilic и тунец 48 штук на Sakura City',
    mustNotMention: ['96'],
  },
  {
    name: 'Корпоративный клиент — на «вы», без «ака»',
    ask: 'Добрый день, меня зовут Гузаль. Подскажите по ассортименту',
    clientName: 'Гузаль',
    mustNotMention: ['ака', 'aka'],
  },
];

/** Грубая эвристика языка: достаточно, чтобы поймать ответ не на том языке */
function looksUzbek(s: string): boolean {
  // Внимание: \b в JavaScript определён через [A-Za-z0-9_] и с кириллицей
  // не работает вовсе — «\bбор\b» не совпадёт никогда. Поэтому границы слов
  // здесь не используем, ищем морфемы как подстроки.
  const uz = /(alayk|assalom|salom|rahmat|raxmat|narx|qanch|bormi|yo'q|kerak|mumkin|topil|so'm|bering|qiling|uchun|нарх|қанч|борми|йўқ|керак|мумкин|топил|сўм|учун|қил|бўл|раҳмат|салом|бор,|бор\.|бор\?|ака|сумдан|омборда|миқдор)/i;

  // Русские маркеры, которых в узбекском ответе быть не должно
  const ru = /(здравств|извините|пожалуйста|стоит|рублей|в наличии|уточн|можете|которы|сейчас|сколько)/i;

  return uz.test(s) && !ru.test(s);
}

function check(c: Case, t: AgentTurn): string[] {
  const fails: string[] = [];
  const called = t.toolCalls.map((x) => x.name);
  const reply = (t.reply ?? '').toLowerCase();

  if (t.error) fails.push(`ошибка: ${t.error}`);

  for (const need of c.mustCall ?? []) {
    if (!called.includes(need)) fails.push(`не вызвала ${need}`);
  }
  for (const bad of c.mustNotCall ?? []) {
    if (called.includes(bad)) fails.push(`зря вызвала ${bad}`);
  }
  if (c.mustHandoff && !t.handoff) fails.push('не передала менеджеру');

  for (const m of c.mustMention ?? []) {
    if (!reply.includes(m.toLowerCase())) fails.push(`нет упоминания «${m}»`);
  }
  for (const m of c.mustNotMention ?? []) {
    if (reply.includes(m.toLowerCase())) fails.push(`лишнее упоминание «${m}»`);
  }
  if (c.lang === 'uz' && t.reply && !looksUzbek(t.reply)) {
    fails.push('ответила не на узбекском');
  }
  return fails;
}

async function main() {
  if (!config.GEMINI_API_KEY) {
    console.error(`\n${C.red}GEMINI_API_KEY не задан — проверки запустить нельзя.${C.reset}\n`);
    process.exit(1);
  }
  await migrate();

  console.log(`\n${C.dim}─────────────────────────────────────────────${C.reset}`);
  console.log(`  ${C.bold}Проверки поведения${C.reset}  ${C.dim}${config.GEMINI_MODEL}${C.reset}`);
  console.log(`${C.dim}─────────────────────────────────────────────${C.reset}\n`);

  let passed = 0;
  const failures: { c: Case; fails: string[]; reply: string }[] = [];

  for (const c of CASES) {
    const t = await runAgent({
      message: c.ask,
      channel: 'A',
      ctx: { marketId: -1 },
      clientName: c.clientName === undefined ? 'Азиз' : c.clientName,
      marketName: 'MARKET 1 · Чиланзар',
    });

    const fails = check(c, t);
    if (fails.length === 0) {
      passed++;
      console.log(`${C.green}✓${C.reset} ${c.name}`);
    } else {
      console.log(`${C.red}✗${C.reset} ${c.name}`);
      fails.forEach((f) => console.log(`${C.dim}    ${f}${C.reset}`));
      failures.push({ c, fails, reply: t.reply });
    }

    // Бесплатный тариф — 15 запросов в минуту. Не спешим.
    await new Promise((r) => setTimeout(r, 9000));
  }

  console.log(`\n${C.dim}─────────────────────────────────────────────${C.reset}`);
  const pct = Math.round((passed / CASES.length) * 100);
  const color = pct === 100 ? C.green : pct >= 80 ? C.yellow : C.red;
  console.log(`  ${color}${passed} из ${CASES.length} (${pct}%)${C.reset}`);

  if (failures.length) {
    console.log(`\n  ${C.bold}Что ответила там, где не прошло:${C.reset}\n`);
    for (const f of failures) {
      console.log(`  ${C.dim}«${f.c.ask}»${C.reset}`);
      console.log(`  → ${f.reply || '(промолчала)'}\n`);
    }
  }
  console.log(`${C.dim}─────────────────────────────────────────────${C.reset}\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\nПроверки упали:', (e as Error).message, '\n');
  process.exit(1);
});
