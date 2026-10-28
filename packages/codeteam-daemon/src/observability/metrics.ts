import { METRIC_LABEL_ALLOWLIST } from "./redaction.ts";

export type MetricKind = "counter" | "gauge" | "histogram";
export type MetricLabelValue = string | number | boolean;
export type MetricLabels = Readonly<Record<string, MetricLabelValue>>;

export interface CounterHandle {
	add(value?: number): void;
	get(): number;
}

export interface GaugeHandle {
	set(value: number): void;
	get(): number;
}

export interface HistogramHandle {
	observe(value: number): void;
}

interface Series {
	readonly name: string;
	readonly kind: MetricKind;
	readonly labels: Readonly<Record<string, MetricLabelValue>>;
	value: number;
	buckets?: number[];
	counts?: number[];
	sum?: number;
	count?: number;
}

const METRIC_NAME = /^codeteam_[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const MAX_LABEL_VALUE_LENGTH = 128;

/**
 * Bounded metric registry with a Prometheus text snapshot. Labels are
 * allowlisted and values are length-capped; unknown labels are dropped.
 */
export class MetricsRegistry {
	private readonly series = new Map<string, Series>();
	private readonly kinds = new Map<string, MetricKind>();
	private droppedLabels = 0;

	counter(name: string, labels: MetricLabels = {}): CounterHandle {
		const series = this.getOrCreate(name, "counter", labels);
		return {
			add: (value = 1) => {
				if (!Number.isFinite(value) || value === 0) return;
				series.value += value;
			},
			get: () => series.value,
		};
	}

	gauge(name: string, labels: MetricLabels = {}): GaugeHandle {
		const series = this.getOrCreate(name, "gauge", labels);
		return {
			set: (value: number) => {
				if (!Number.isFinite(value)) return;
				series.value = value;
			},
			get: () => series.value,
		};
	}

	histogram(name: string, labels: MetricLabels = {}, buckets: readonly number[] = DEFAULT_BUCKETS): HistogramHandle {
		const series = this.getOrCreate(name, "histogram", labels);
		if (!series.buckets || !series.counts) {
			series.buckets = normalizeBuckets(buckets);
			series.counts = new Array(series.buckets.length).fill(0) as number[];
			series.sum = 0;
			series.count = 0;
		}
		return {
			observe: (value: number) => {
				if (!Number.isFinite(value)) return;
				series.sum = (series.sum ?? 0) + value;
				series.count = (series.count ?? 0) + 1;
				const buckets = series.buckets ?? [];
				const counts = series.counts ?? [];
				for (let index = 0; index < buckets.length; index += 1) {
					if (value <= buckets[index]!) counts[index] = (counts[index] ?? 0) + 1;
				}
			},
		};
	}

	seriesCount(): number {
		return this.series.size;
	}

	droppedLabelCount(): number {
		return this.droppedLabels;
	}

	renderPrometheus(): string {
		const groups = new Map<string, Series[]>();
		for (const series of this.series.values()) {
			const list = groups.get(series.name) ?? [];
			list.push(series);
			groups.set(series.name, list);
		}
		const lines: string[] = [];
		for (const [name, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			const kind = this.kinds.get(name) ?? "gauge";
			lines.push(`# HELP ${name} codeteam local metric`);
			lines.push(`# TYPE ${name} ${kind}`);
			for (const series of list.sort((a, b) => labelKey(a.labels).localeCompare(labelKey(b.labels)))) {
				if (kind === "histogram") {
					const buckets = series.buckets ?? [];
					const counts = series.counts ?? [];
					for (let index = 0; index < buckets.length; index += 1) {
						lines.push(
							`${name}_bucket${formatLabels(series.labels, { le: String(buckets[index]) })} ${counts[index] ?? 0}`,
						);
					}
					lines.push(`${name}_bucket${formatLabels(series.labels, { le: "+Inf" })} ${series.count ?? 0}`);
					lines.push(`${name}_sum${formatLabels(series.labels)} ${formatNumber(series.sum ?? 0)}`);
					lines.push(`${name}_count${formatLabels(series.labels)} ${series.count ?? 0}`);
				} else {
					lines.push(`${name}${formatLabels(series.labels)} ${formatNumber(series.value)}`);
				}
			}
		}
		return lines.length > 0 ? `${lines.join("\n")}\n` : "";
	}

	private getOrCreate(name: string, kind: MetricKind, labels: MetricLabels): Series {
		if (!METRIC_NAME.test(name)) throw new Error(`invalid_metric_name: ${name}`);
		const existingKind = this.kinds.get(name);
		if (existingKind && existingKind !== kind) throw new Error(`metric_kind_mismatch: ${name}`);
		this.kinds.set(name, kind);
		const sanitized = sanitizeLabels(labels, () => {
			this.droppedLabels += 1;
		});
		const key = `${name}|${labelKey(sanitized)}`;
		let series = this.series.get(key);
		if (!series) {
			series = { name, kind, labels: sanitized, value: 0 };
			this.series.set(key, series);
		}
		return series;
	}
}

function sanitizeLabels(labels: MetricLabels, onDrop: () => void): Readonly<Record<string, MetricLabelValue>> {
	const result: Record<string, MetricLabelValue> = {};
	for (const [key, value] of Object.entries(labels)) {
		if (!METRIC_LABEL_ALLOWLIST.has(key)) {
			onDrop();
			continue;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value)) {
				onDrop();
				continue;
			}
			result[key] = value;
			continue;
		}
		if (typeof value === "boolean") {
			result[key] = value;
			continue;
		}
		if (typeof value === "string") {
			if (value.length === 0 || value.length > MAX_LABEL_VALUE_LENGTH || /[\r\n]/.test(value)) {
				onDrop();
				continue;
			}
			result[key] = value;
			continue;
		}
		onDrop();
	}
	return result;
}

function normalizeBuckets(buckets: readonly number[]): number[] {
	const sorted = [...new Set(buckets.filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
	return sorted.length > 0 ? sorted : [...DEFAULT_BUCKETS];
}

function labelKey(labels: Readonly<Record<string, MetricLabelValue>>): string {
	return Object.keys(labels)
		.sort()
		.map((key) => `${key}=${String(labels[key])}`)
		.join(",");
}

function formatLabels(
	labels: Readonly<Record<string, MetricLabelValue>>,
	extra: Readonly<Record<string, string>> = {},
): string {
	const entries = [
		...Object.entries(labels).map(([key, value]) => [key, String(value)] as const),
		...Object.entries(extra),
	];
	if (entries.length === 0) return "";
	entries.sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function escapeLabelValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
}
