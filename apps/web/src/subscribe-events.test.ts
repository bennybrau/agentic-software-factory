import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeEvents, type QueueChange } from './api';

// A stand-in EventSource: records listeners so the test can fire frames by name.
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(name: string, fn: (ev: { data: string }) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  fire(name: string, data: unknown) { for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

test('subscribeEvents: queue:changed goes to onQueue on the same stream, not to onEvent', () => {
  const events: unknown[] = [];
  const changes: QueueChange[] = [];
  const off = subscribeEvents((e) => events.push(e), undefined, { onQueue: (c) => changes.push(c) });
  const es = FakeEventSource.last!;
  assert.equal(es.url, '/api/events');
  es.fire('queue:changed', { id: 'q1', state: 'failed' });
  assert.deepEqual(changes, [{ id: 'q1', state: 'failed' }]);
  assert.deepEqual(events, []);
  es.fire('run:event', { runId: 'r1', seq: 1 });
  assert.equal(events.length, 1);
  assert.equal(changes.length, 1);
  off();
  assert.equal(es.closed, true);
});

test('subscribeEvents without onQueue ignores queue:changed', () => {
  const events: unknown[] = [];
  subscribeEvents((e) => events.push(e));
  FakeEventSource.last!.fire('queue:changed', { id: 'q1', state: 'failed' });
  assert.deepEqual(events, []);
});
