export function daysBetween(start, end) {
  const startDate = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  return Math.round((last.getTime() - startDate.getTime()) / 86_400_000);
}

export function eachDay(start, end, { inclusive = true } = {}) {
  const days = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (last < cursor) return [];
  while (cursor <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
