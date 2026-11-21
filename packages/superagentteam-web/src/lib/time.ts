export function formatRelative(timestamp: number): string {
	const diff = Date.now() - timestamp;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}

export function formatElapsed(startedAt: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
	if (minutes < 1) return "不到 1 分";
	if (minutes < 60) return `${minutes} 分`;
	const hours = Math.floor(minutes / 60);
	return `${hours} 时`;
}
