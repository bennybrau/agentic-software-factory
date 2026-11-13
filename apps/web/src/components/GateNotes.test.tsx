import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GateWire } from '@asf/shared';
import { GateNotes } from './GateNotes';

const gate = (over: Partial<GateWire> = {}): GateWire => ({ id: 'g_1', runId: 'run_1', gateName: 'after_plan', mode: 'required', state: 'approved',
  afterTask: null, artifact: 'plan', decidedBy: 'jon', note: 'Use Node.', editedArtifact: null, createdAt: '', decidedAt: '2026-11-11T10:00:00Z',
  hiveSentAt: null, ...over });

test('a decided gate with a note shows its title, decision, who and the note', () => {
  const html = renderToStaticMarkup(<GateNotes gates={[gate()]} />);
  assert.match(html, /Gate notes/);
  assert.match(html, /Approve the plan · Approved by jon/);
  assert.match(html, /Use Node\./);
});

test('"Sent to team memory for review" shows only when hiveSentAt is set', () => {
  assert.doesNotMatch(renderToStaticMarkup(<GateNotes gates={[gate()]} />), /Sent to team memory/);
  assert.match(renderToStaticMarkup(<GateNotes gates={[gate({ hiveSentAt: '2026-11-11T10:01:00Z' })]} />), /Sent to team memory for review/);
});

test('open gates and gates without a note show nothing', () => {
  const html = renderToStaticMarkup(<GateNotes gates={[gate({ state: 'open', decidedAt: null, note: null }), gate({ id: 'g_2', note: '  ' })]} />);
  assert.equal(html, '');
});

test('a planner chat reply at the plan gate reads "Asked for a change", not "Rejected by"', () => {
  const html = renderToStaticMarkup(<GateNotes gates={[gate({ state: 'rejected', decision: 'reply', note: 'Also handle empty input.' })]} />);
  assert.match(html, /Approve the plan · Asked for a change · jon/);
  assert.doesNotMatch(html, /Rejected/);
});

test('a Reject and an approve keep their words, with or without a decision', () => {
  assert.match(renderToStaticMarkup(<GateNotes gates={[gate({ state: 'rejected', decision: 'reject' })]} />), /Approve the plan · Rejected by jon/);
  assert.match(renderToStaticMarkup(<GateNotes gates={[gate({ state: 'rejected' })]} />), /Approve the plan · Rejected by jon/);
  assert.match(renderToStaticMarkup(<GateNotes gates={[gate({ decision: 'approve' })]} />), /Approve the plan · Approved by jon/);
});
