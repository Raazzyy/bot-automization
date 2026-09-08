/**
 * Деньги — в целых сумах, строкой.
 * Никаких float: 0.1 + 0.2 в сумах превращается в спор с бухгалтерией.
 */

/** Приводит что угодно из Linko к целому числу сумов */
export function toSum(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** 8420000 → «8 420 000 сум» */
export function fmtSum(v: unknown): string {
  return `${toSum(v).toLocaleString('ru-RU').replace(/ /g, ' ')} сум`;
}

/** 8420000 → «8 420 000» без единицы */
export function fmtNum(v: unknown): string {
  return toSum(v).toLocaleString('ru-RU').replace(/ /g, ' ');
}

/** Количество может быть дробным (весовой товар) */
export function fmtAmount(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
}

/** «2026-02-20» → «20.02.2026» */
export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Сегодня в Ташкенте, YYYY-MM-DD */
export function todayTashkent(offsetHours = 5): string {
  return new Date(Date.now() + offsetHours * 3600_000).toISOString().slice(0, 10);
}

/** Разница в днях между YYYY-MM-DD и сегодня (положительная = дата в прошлом) */
export function daysAgo(iso: string | null | undefined, offsetHours = 5): number | null {
  if (!iso) return null;
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return null;
  const today = Date.parse(todayTashkent(offsetHours));
  return Math.round((today - d) / 86_400_000);
}
