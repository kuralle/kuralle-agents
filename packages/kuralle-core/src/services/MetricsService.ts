
import type { ObservabilityMetrics, MetricsConfig, Span, Metrics } from '../types/index.js';

export interface MetricsService extends ObservabilityMetrics {
    getAll(): {
        counters: Record<string, number>;
        gauges: Record<string, number>;
        histograms: Record<string, { count: number; mean: number; min: number; max: number }>;
        timings: Record<string, { count: number; mean: number; p50: number; p95: number; p99: number }>;
    };
    reset(): void;
}

export class InMemoryMetricsService implements MetricsService {
    private counters = new Map<string, number>();
    private gauges = new Map<string, number>();
    private histograms = new Map<string, number[]>();
    private timings = new Map<string, number[]>();
    private spans: Span[] = [];
    private config: MetricsConfig;

    constructor(config: MetricsConfig = {}) {
        this.config = config;
    }

    private makeKey(name: string, tags?: Record<string, string>): string {
        const { prefix = 'kuralle', tags: globalTags = {} } = this.config;
        const allTags = { ...globalTags, ...tags };

        // Prefix logic from helpers.ts
        const fullName = prefix ? `${prefix}.${name}` : name;

        if (!allTags || Object.keys(allTags).length === 0) return fullName;
        const tagStr = Object.entries(allTags).map(([k, v]) => `${k}:${v}`).join(',');
        return `${fullName}{${tagStr}}`;
    }

    increment(name: string, value: number = 1, tags?: Record<string, string>): void {
        const key = this.makeKey(name, tags);
        this.counters.set(key, (this.counters.get(key) ?? 0) + value);
    }

    gauge(name: string, value: number, tags?: Record<string, string>): void {
        const key = this.makeKey(name, tags);
        this.gauges.set(key, value);
    }

    histogram(name: string, value: number, tags?: Record<string, string>): void {
        const key = this.makeKey(name, tags);
        const values = this.histograms.get(key) ?? [];
        values.push(value);
        this.histograms.set(key, values);
    }

    timing(name: string, value: number, tags?: Record<string, string>): void {
        const key = this.makeKey(name, tags);
        const values = this.timings.get(key) ?? [];
        values.push(value);
        this.timings.set(key, values);
    }

    recordSpan(span: Span): void {
        this.spans.push(span);
        if (span.endTime && span.startTime) {
            this.timing('span.duration', span.endTime - span.startTime, {
                spanName: span.name,
                status: span.status,
            });
        }
    }

    getAll(): {
        counters: Record<string, number>;
        gauges: Record<string, number>;
        histograms: Record<string, { count: number; mean: number; min: number; max: number }>;
        timings: Record<string, { count: number; mean: number; p50: number; p95: number; p99: number }>;
    } {
        const histogramStats: Record<string, { count: number; mean: number; min: number; max: number }> = {};
        for (const [key, values] of this.histograms) {
            histogramStats[key] = {
                count: values.length,
                mean: values.reduce((a, b) => a + b, 0) / values.length,
                min: Math.min(...values),
                max: Math.max(...values),
            };
        }

        const timingStats: Record<string, { count: number; mean: number; p50: number; p95: number; p99: number }> = {};
        for (const [key, values] of this.timings) {
            const sorted = [...values].sort((a, b) => a - b);
            timingStats[key] = {
                count: values.length,
                mean: values.reduce((a, b) => a + b, 0) / values.length,
                p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
                p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
                p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
            };
        }

        return {
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges),
            histograms: histogramStats,
            timings: timingStats,
        };
    }

    reset(): void {
        this.counters.clear();
        this.gauges.clear();
        this.histograms.clear();
        this.timings.clear();
        this.spans = [];
    }
}
