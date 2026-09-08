/**
 * Нормализация узбекских номеров в E.164.
 *
 * Правила выведены из реального файла «НОМЕРА ДЛЯ БОТА.xlsx» (781 строка):
 * встречаются форматы +998XXXXXXXXX, 998XXXXXXXXX, XXXXXXXXX (9 цифр),
 * а также испорченные Excel'ом значения, где число потеряло старшие разряды.
 */

// Действующие коды мобильных операторов Узбекистана
const OPERATOR_CODES = new Set([
  '90', '91', '93', '94', '95', '97', '98', '99', // основные
  '33', '50', '55', '77', '88', // Humans, Perfectum, Uzmobile и др.
  '20', // новые выделения
]);

export type PhoneResult =
  | { ok: true; e164: string; operator: string }
  | { ok: false; raw: string; reason: string };

export function normalizePhone(input: unknown): PhoneResult {
  const raw = String(input ?? '').trim();
  const d = raw.replace(/\D/g, '');

  if (!d) return { ok: false, raw, reason: 'пусто' };

  // 998XXXXXXXXX — со страновым кодом
  if (d.length === 12 && d.startsWith('998')) {
    const op = d.slice(3, 5);
    if (!OPERATOR_CODES.has(op)) {
      return { ok: false, raw, reason: `неизвестный код оператора ${op}` };
    }
    return { ok: true, e164: `+${d}`, operator: op };
  }

  // XXXXXXXXX — 9 цифр, без странового кода
  if (d.length === 9) {
    const op = d.slice(0, 2);
    if (!OPERATOR_CODES.has(op)) {
      return { ok: false, raw, reason: `неизвестный код оператора ${op}` };
    }
    return { ok: true, e164: `+998${d}`, operator: op };
  }

  // Excel сохранил номер числом и потерял старшие цифры.
  // Восстанавливать наугад нельзя — отправляем на ручную проверку.
  if (d.length === 10 || d.length === 11) {
    return { ok: false, raw, reason: `${d.length} цифр — вероятно потеряны цифры при выгрузке из Excel` };
  }

  return { ok: false, raw, reason: `${d.length} цифр — не похоже на номер` };
}

/** Ключ для поиска: только цифры без странового кода. Так ищем в Linko. */
export function phoneKey(e164: string): string {
  return e164.replace(/\D/g, '').replace(/^998/, '');
}

/** Человекочитаемый вид: +998 90 123 45 67 */
export function formatPhone(e164: string): string {
  const d = e164.replace(/\D/g, '');
  if (d.length !== 12) return e164;
  return `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10)}`;
}
