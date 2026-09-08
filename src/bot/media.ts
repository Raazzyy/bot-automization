import type { Api } from 'grammy';
import { InputFile } from 'grammy';
import { eq, sql } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { getDb } from '../db/index.js';
import { mediaFiles } from '../db/schema.js';
import { log } from '../lib/logger.js';

/**
 * Отправка файлов из библиотеки.
 *
 * Telegram позволяет переиспользовать file_id: первый раз файл заливается
 * с диска, дальше отправляется одним идентификатором — мгновенно и без
 * нагрузки на канал. Поэтому после первой отправки file_id сохраняем.
 *
 * В отличие от inline-кнопок, файлы от имени бизнес-аккаунта Telegram
 * отправлять разрешает — проверено по типам Bot API.
 */

export interface SendFileResult {
  ok: boolean;
  key: string;
  error?: string;
}

export async function sendMediaByKey(
  api: Api,
  chatId: number | string,
  key: string,
  businessConnectionId?: string,
): Promise<SendFileResult> {
  const db = await getDb();
  const [f] = await db.select().from(mediaFiles).where(eq(mediaFiles.key, key)).limit(1);

  if (!f) return { ok: false, key, error: 'файла нет в библиотеке' };
  if (!f.isActive) return { ok: false, key, error: 'файл выключен' };

  // Уже заливали — шлём по идентификатору. Иначе с диска.
  let source: string | InputFile;
  if (f.fileId) {
    source = f.fileId;
  } else if (f.path && existsSync(f.path)) {
    source = new InputFile(f.path);
  } else {
    return { ok: false, key, error: `файл не найден на диске: ${f.path ?? '(путь не задан)'}` };
  }

  const opts = {
    caption: f.caption ?? undefined,
    ...(businessConnectionId ? { business_connection_id: businessConnectionId } : {}),
  };

  try {
    let newFileId: string | undefined;

    switch (f.kind) {
      case 'photo': {
        const m = await api.sendPhoto(chatId, source, opts);
        newFileId = m.photo?.at(-1)?.file_id;
        break;
      }
      case 'video': {
        const m = await api.sendVideo(chatId, source, opts);
        newFileId = m.video?.file_id;
        break;
      }
      case 'voice': {
        const m = await api.sendVoice(chatId, source, opts);
        newFileId = m.voice?.file_id;
        break;
      }
      default: {
        const m = await api.sendDocument(chatId, source, opts);
        newFileId = m.document?.file_id;
      }
    }

    await db.update(mediaFiles).set({
      ...(newFileId && !f.fileId ? { fileId: newFileId } : {}),
      sentCount: sql`${mediaFiles.sentCount} + 1`,
      updatedAt: new Date(),
    }).where(eq(mediaFiles.key, key));

    if (newFileId && !f.fileId) {
      log.info(`Файл «${f.title}» залит, file_id сохранён — дальше уйдёт мгновенно`);
    }

    return { ok: true, key };
  } catch (e) {
    const error = (e as Error).message;
    log.error(`Не удалось отправить файл «${key}»`, error);
    return { ok: false, key, error };
  }
}

/** Отправить пачку файлов по ключам */
export async function sendAttachments(
  api: Api,
  chatId: number | string,
  keys: string[],
  businessConnectionId?: string,
): Promise<SendFileResult[]> {
  const out: SendFileResult[] = [];
  for (const key of keys) {
    out.push(await sendMediaByKey(api, chatId, key, businessConnectionId));
  }
  return out;
}
