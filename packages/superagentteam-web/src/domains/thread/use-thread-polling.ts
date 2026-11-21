import { useEffect } from "react";

export function useThreadPolling(load: () => Promise<void>, intervalMs = 10_000): void {
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const tick = async (): Promise<void> => {
			if (cancelled) return;
			if (!document.hidden) await load();
			if (!cancelled) timer = setTimeout(() => void tick(), intervalMs);
		};

		void tick();
		const onVisibility = (): void => {
			if (!document.hidden) void load();
		};
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			cancelled = true;
			if (timer !== undefined) clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [load, intervalMs]);
}
