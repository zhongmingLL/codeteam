export function daysBetween(start, end) {
  const startDate = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  return Math.round((last.getTime() - startDate.getTime()) / 86_400_000);
}
