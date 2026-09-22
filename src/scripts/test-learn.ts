import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

async function main() {
  const dir = 'C:\\Users\\raazzyy\\Downloads\\Telegram Desktop\\чаты акм';
  const htmlPath = path.join(dir, 'ChatExport_2026-09-12', 'messages.html');

  if (!fs.existsSync(htmlPath)) {
    console.error('Файл не найден:', htmlPath);
    return;
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const re = /<div class="from_name">\s*([\s\S]*?)\s*<\/div>[\s\S]*?<div class="text">\s*([\s\S]*?)\s*<\/div>/g;
  const messages: string[] = [];
  let m;
  while ((m = re.exec(html)) !== null && messages.length < 40) {
    const sender = (m[1] ?? '').replace(/<[^>]+>/g, '').trim();
    const text = (m[2] ?? '').replace(/<[^>]+>/g, '').trim();
    if (text) {
      messages.push(`${sender}: ${text}`);
    }
  }

  console.log(`Подготовлено ${messages.length} реплик для анализа через Gemini (${config.GEMINI_MODEL})...`);

  const prompt = `
Ты эксперт по анализу переписок в оптовой B2B торговле продуктами питания (FMCG/HoReCa) в Узбекистане.
Компания: AKM Distribution (дистрибьютор Dardanel, Burcu, Sayam).

Вот фрагмент реальной переписки между клиентом и менеджером:
"""
${messages.join('\n')}
"""

Проанализируй эти сообщения и выдели:
1. Сленговые или сокращенные названия товаров (как клиент называет товар, граммовку, тип) -> сопоставь с официальным товаром.
2. Реальные вопросы клиента и как менеджер ответил (золотые паттерны диалога).
3. Важные договоренности, особенности работы или правила, упомянутые в чате.

Ответь строго в формате JSON:
{
  "extractedAliases": [
    { "clientPhrase": "...", "formalProduct": "...", "notes": "..." }
  ],
  "goldenDialogues": [
    { "clientQuestion": "...", "managerAnswer": "...", "topic": "..." }
  ],
  "businessInsights": [
    "..."
  ]
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

  const json = await res.json() as any;
  console.log('\n✅ Успешное извлечение знаний через Gemini:');
  console.log(json.candidates?.[0]?.content?.parts?.[0]?.text);
}

main().catch(console.error);
