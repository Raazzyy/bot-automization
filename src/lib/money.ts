export function toSum(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function fmtSum(v: unknown): string {
  return `${toSum(v).toLocaleString('ru-RU').replace(/ /g, ' ')} сум`;
}

export function fmtNum(v: unknown): string {
  return toSum(v).toLocaleString('ru-RU').replace(/ /g, ' ');
}

export function fmtAmount(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export function todayTashkent(offsetHours = 5): string {
  return new Date(Date.now() + offsetHours * 3600_000).toISOString().slice(0, 10);
}

export function daysAgo(iso: string | null | undefined, offsetHours = 5): number | null {
  if (!iso) return null;
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return null;
  const today = Date.parse(todayTashkent(offsetHours));
  return Math.round((today - d) / 86_400_000);
}
