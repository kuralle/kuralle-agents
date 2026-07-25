
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TracingService } from '../dist/services/TracingService.js';
import { InMemoryMetricsService } from '../dist/services/MetricsService.js';

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
