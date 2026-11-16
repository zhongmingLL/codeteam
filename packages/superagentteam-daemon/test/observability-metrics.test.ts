import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../src/observability/metrics.ts";

describe("W6c metrics snapshot", () => {
	it("renders counters, gauges, and histograms in Prometheus text format", () => {
		const metrics = new MetricsRegistry();
		metrics.counter("superagentteam_runs_total", { role: "coder", provider: "test", status: "completed" }).add(2);
		metrics.gauge("superagentteam_trace_spans", {}).set(3);
		metrics.histogram("superagentteam_run_duration_ms", { role: "coder" }).observe(12);
		const text = metrics.renderPrometheus();
		expect(text).toContain("# TYPE superagentteam_runs_total counter");
		expect(text).toContain('superagentteam_runs_total{provider="test",role="coder",status="completed"} 2');
		expect(text).toContain("# TYPE superagentteam_trace_spans gauge");
		expect(text).toContain("superagentteam_trace_spans 3");
		expect(text).toContain('superagentteam_run_duration_ms_bucket{le="10",role="coder"} 0');
		expect(text).toContain('superagentteam_run_duration_ms_bucket{le="25",role="coder"} 1');
		expect(text).toContain('superagentteam_run_duration_ms_sum{role="coder"} 12');
		expect(text).toContain('superagentteam_run_duration_ms_count{role="coder"} 1');
	});

	it("drops unknown and high-cardinality labels", () => {
		const metrics = new MetricsRegistry();
		metrics.counter("superagentteam_runs_total", { role: "coder", threadId: "thread-1" }).add(1);
		expect(metrics.droppedLabelCount()).toBe(1);
		expect(metrics.renderPrometheus()).not.toContain("thread-1");
	});

	it("escapes label values and rejects invalid metric names", () => {
		const metrics = new MetricsRegistry();
		metrics.counter("superagentteam_events_total", { status: 'a"b\\c' }).add(1);
		expect(metrics.renderPrometheus()).toContain('status="a\\"b\\\\c"');
		expect(() => metrics.counter("bad-name", {})).toThrowError("invalid_metric_name");
	});

	it("caps series growth and counts dropped series", () => {
		const metrics = new MetricsRegistry({ maxSeries: 2 });
		metrics.counter("superagentteam_events_total", { role: "coder" }).add(1);
		metrics.counter("superagentteam_events_total", { role: "reviewer" }).add(1);
		metrics.counter("superagentteam_events_total", { role: "verifier" }).add(1);
		expect(metrics.seriesCount()).toBe(2);
		expect(metrics.droppedSeriesCount()).toBe(1);
		expect(metrics.renderPrometheus()).not.toContain('role="verifier"');
	});
});
