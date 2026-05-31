
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TracingService } from '../dist/services/TracingService.js';
import { InMemoryMetricsService } from '../dist/services/MetricsService.js';
import { createTracingHooks, createObservabilityHooks } from '../dist/hooks/helpers.js';

test('TracingService maintains isolated state', () => {
  const service1 = new TracingService({ serviceName: 's1' });
  const service2 = new TracingService({ serviceName: 's2' });

  const span1 = service1.startSpan('span1');
  const span2 = service2.startSpan('span2');

  assert.equal(service1.getCurrentSpan()?.id, span1.id);
  assert.equal(service2.getCurrentSpan()?.id, span2.id);

  service1.endSpan(span1);

  assert.equal(service1.getCurrentSpan(), undefined);
  // service2 should still have its span active
  assert.equal(service2.getCurrentSpan()?.id, span2.id);
});

test('InMemoryMetricsService maintains isolated state', () => {
  const m1 = new InMemoryMetricsService({ prefix: '' });
  const m2 = new InMemoryMetricsService({ prefix: '' });

  m1.increment('counter');
  m2.increment('counter', 5);

  assert.equal(m1.getAll().counters['counter'], 1);
  assert.equal(m2.getAll().counters['counter'], 5);
});

test('createTracingHooks uses injected service', async () => {
  const service = new TracingService({ serviceName: 'test' });
  // Mock context
  const context = {
    session: { id: 's1' },
    agentId: 'a1',
  };

  const hooks = createTracingHooks(service);
  
  await hooks.onAgentStart(context, 'a1');
  
  const span = service.getCurrentSpan();
  assert.ok(span, 'Span should be started in injected service');
  assert.equal(span.name, 'agent.run');
  assert.equal(span.attributes.agentId, 'a1');
});

test('createObservabilityHooks uses injected service', async () => {
    const service = new InMemoryMetricsService();
    const context = {
        agentId: 'a1',
        startTime: Date.now(),
        session: { id: 's1' },
    }
    const hooks = createObservabilityHooks(service);

    await hooks.onStart(context);

    const metrics = service.getAll();
    assert.equal(metrics.counters['kuralle.run.start{agent:a1}'], 1);
})
