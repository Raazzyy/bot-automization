import fs from 'node:fs';
import path from 'node:path';
import {
  parseTelegramHtmlMessages,
  analyzeDialogueBatch,
  saveLearnedKnowledge,
  type ExtractedAlias,
  type GoldenDialogue,
  type ClientProfile,
  type LearnedKnowledge,
} from '../ai/chat-learner.js';
import { log } from '../lib/logger.js';

async function main() {
  console.log('Запуск анализа переписок Telegram...');

  const defaultExportDir = 'C:\\Users\\raazzyy\\Downloads\\Telegram Desktop\\чаты акм';
  const targetDir = process.env.CHAT_EXPORT_DIR || defaultExportDir;

  if (!fs.existsSync(targetDir)) {
    console.error(`Каталог экспорта переписок не найден: ${targetDir}`);
    process.exit(1);
  }

  const exportFolders = fs.readdirSync(targetDir).filter((f) => f.startsWith('ChatExport'));
  console.log(`Найдено ${exportFolders.length} папок с экспортами переписок.`);

  const allAliases: ExtractedAlias[] = [];
  const allDialogues: GoldenDialogue[] = [];
  const allProfiles: ClientProfile[] = [];
  const allInsights: string[] = [];
  let totalMessagesCount = 0;

  const foldersToProcess = exportFolders.slice(0, 6);

  for (let i = 0; i < foldersToProcess.length; i++) {
    const folder = foldersToProcess[i];
    if (!folder) continue;
    const htmlPath = path.join(targetDir, folder, 'messages.html');
    if (!fs.existsSync(htmlPath)) continue;

    const html = fs.readFileSync(htmlPath, 'utf8');
    const titleMatch = html.match(/<div class="text bold">\s*([\s\S]*?)\s*<\/div>/);
    const clientName = titleMatch?.[1] ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Клиент ${i + 1}`;

    const parsedMessages = parseTelegramHtmlMessages(html);
    totalMessagesCount += parsedMessages.length;

    console.log(`[${i + 1}/${foldersToProcess.length}] Анализ диалога «${clientName}» (${parsedMessages.length} реплик)...`);

    const sample = parsedMessages.slice(0, 45);
    if (sample.length < 5) {
      console.log('  Пропуск: недостаточно сообщений для анализа.');
      continue;
    }

    try {
      const result = await analyzeDialogueBatch(clientName, sample);

      console.log(`  Извлечено синонимов: ${result.aliases.length}, диалогов: ${result.dialogues.length}, инсайтов: ${result.insights.length}`);
      if (result.profile.typicalProducts?.length) {
        console.log(`  Товары: ${result.profile.typicalProducts.join(', ')}`);
      }

      allAliases.push(...result.aliases);
      allDialogues.push(...result.dialogues);
      allProfiles.push(result.profile);
      allInsights.push(...result.insights);
    } catch (err) {
      log.warn(`Ошибка анализа диалога ${clientName}:`, (err as Error).message);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  const uniqueAliasesMap = new Map<string, ExtractedAlias>();
  for (const a of allAliases) {
    const key = a.clientPhrase.toLowerCase().trim();
    if (!uniqueAliasesMap.has(key)) {
      uniqueAliasesMap.set(key, a);
    }
  }

  const finalKnowledge: LearnedKnowledge = {
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
    totalAnalyzedMessages: totalMessagesCount,
    totalClients: allProfiles.length,
    extractedAliases: Array.from(uniqueAliasesMap.values()),
    goldenDialogues: allDialogues.slice(0, 20),
    clientProfiles: allProfiles,
    businessInsights: Array.from(new Set(allInsights)),
  };

  saveLearnedKnowledge(finalKnowledge);

  console.log('Анализ переписок успешно завершен.');
  console.log(`- Проанализировано сообщений: ${totalMessagesCount}`);
  console.log(`- Профилей клиентов:          ${finalKnowledge.clientProfiles.length}`);
  console.log(`- Сленговых синонимов:        ${finalKnowledge.extractedAliases.length}`);
  console.log(`- Золотых диалогов:           ${finalKnowledge.goldenDialogues.length}`);
  console.log(`- Бизнес-инсайтов:            ${finalKnowledge.businessInsights.length}`);
  console.log(`- База знаний сохранена в:    src/ai/learned-knowledge.json`);
}

main().catch((e) => {
  console.error('Ошибка самообучения:', e);
  process.exit(1);
});

