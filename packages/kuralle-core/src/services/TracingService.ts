
import type { TracingConfig, Span } from '../types/index.js';

export class TracingService {
    private config: TracingConfig | null = null;
    private spanStack: Span[] = [];

    constructor(config?: TracingConfig) {
        if (config) {
            this.init(config);
        }
    }

    init(config: TracingConfig): void {
        this.config = config;
    }

    startSpan(
        name: string,
        attributes?: Record<string, string | number | boolean>,
        parentSpanId?: string
    ): Span {
        if (!this.config) {
            // Fallback or throw? Helpers threw.
            // We will throw to maintain behavior, but maybe warn in future.
            throw new Error('Tracing not initialized. Call initTracing() first.');
        }

        const span: Span = {
            id: this.generateSpanId(),
            parentId: parentSpanId ?? this.spanStack[this.spanStack.length - 1]?.id,
            name,
            startTime: Date.now(),
            attributes: attributes ?? {},
            events: [],
            status: 'started',
        };

        this.spanStack.push(span);
        return span;
    }

    endSpan(span: Span, status?: 'success' | 'error', error?: Error): Span {
        span.endTime = Date.now();
        span.status = status === 'error' || error ? 'error' : 'ended';

        if (error) {
            span.error = error;
            span.events.push({
                name: 'error',
                timestamp: Date.now(),
                attributes: { message: error.message, stack: error.stack ?? '' },
            });
        }

        const config = this.config;
        if (config?.exporter) {
            config.exporter(span).catch(console.error);
        }

        this.spanStack.pop();
        return span;
    }

    addSpanEvent(
        span: Span,
        name: string,
        attributes?: Record<string, string | number | boolean>
    ): void {
        span.events.push({
            name,
            timestamp: Date.now(),
            attributes,
        });
    }

    getCurrentSpan(): Span | undefined {
        return this.spanStack[this.spanStack.length - 1];
    }

    private generateSpanId(): string {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
}
