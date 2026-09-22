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
  console.log('\n=============================================================');
  console.log('🧠 ЗАПУСК САМООБУЧЕНИЯ ИИ НА РЕАЛЬНЫХ ПЕРЕПИСКАХ TELEGRAM');
  console.log('=============================================================\n');

  const defaultExportDir = 'C:\\Users\\raazzyy\\Downloads\\Telegram Desktop\\чаты акм';
  const targetDir = process.env.CHAT_EXPORT_DIR || defaultExportDir;

  if (!fs.existsSync(targetDir)) {
    console.error(`❌ Каталог экспорта переписок не найден: ${targetDir}`);
    process.exit(1);
  }

  const exportFolders = fs.readdirSync(targetDir).filter((f) => f.startsWith('ChatExport'));
  console.log(`📁 Найдено ${exportFolders.length} папок с экспортами переписок.`);

  const allAliases: ExtractedAlias[] = [];
  const allDialogues: GoldenDialogue[] = [];
  const allProfiles: ClientProfile[] = [];
  const allInsights: string[] = [];
  let totalMessagesCount = 0;

  // Анализируем репрезентативные чаты (например, первые 6 ключевых заведений)
  const foldersToProcess = exportFolders.slice(0, 6);

  for (let i = 0; i < foldersToProcess.length; i++) {
    const folder = foldersToProcess[i];
    if (!folder) continue;
    const htmlPath = path.join(targetDir, folder, 'messages.html');
    if (!fs.existsSync(htmlPath)) continue;

    const html = fs.readFileSync(htmlPath, 'utf8');

    // Определяем имя контакта
    const titleMatch = html.match(/<div class="text bold">\s*([\s\S]*?)\s*<\/div>/);
    const clientName = titleMatch?.[1] ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Клиент ${i + 1}`;

    const parsedMessages = parseTelegramHtmlMessages(html);
    totalMessagesCount += parsedMessages.length;

    console.log(`\n[${i + 1}/${foldersToProcess.length}] 🔍 Анализ диалога с «${clientName}» (${parsedMessages.length} реплик)...`);

    // Берём наиболее насыщенный срез сообщений (до 40-50 реплик)
    const sample = parsedMessages.slice(0, 45);
    if (sample.length < 5) {
      console.log('   ⏭ Слишком мало сообщений для анализа, пропускаем.');
      continue;
    }

    try {
      const result = await analyzeDialogueBatch(clientName, sample);

      console.log(`   ✨ Извлечено синонимов: ${result.aliases.length}, диалогов: ${result.dialogues.length}, инсайтов: ${result.insights.length}`);
      if (result.profile.typicalProducts?.length) {
        console.log(`   📦 Любимые товары: ${result.profile.typicalProducts.join(', ')}`);
      }

      allAliases.push(...result.aliases);
      allDialogues.push(...result.dialogues);
      allProfiles.push(result.profile);
      allInsights.push(...result.insights);
    } catch (err) {
      log.warn(`Ошибка анализа диалога ${clientName}:`, (err as Error).message);
    }

    // Небольшая пауза между запросами к Gemini
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Дедупликация синонимов
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

  console.log('\n=============================================================');
  console.log('🎉 САМООБУЧЕНИЕ УСПЕШНО ЗАВЕРШЕНО!');
  console.log('=============================================================');
  console.log(`• Всего проанализировано сообщений: ${totalMessagesCount}`);
  console.log(`• Профилей заведений сохранено:     ${finalKnowledge.clientProfiles.length}`);
  console.log(`• Уникальных сленговых названий:    ${finalKnowledge.extractedAliases.length}`);
  console.log(`• Золотых диалогов менеджера:       ${finalKnowledge.goldenDialogues.length}`);
  console.log(`• Бизнес-инсайтов и правил:         ${finalKnowledge.businessInsights.length}`);
  console.log(`• Файл базы знаний сохранён в:      src/ai/learned-knowledge.json`);
  console.log('=============================================================\n');
}

main().catch((e) => {
  console.error('❌ Ошибка самообучения:', e);
  process.exit(1);
});
