const { test } = require('node:test');
const assert = require('node:assert/strict');

test('running transfer stays first when jobs are added and its successor takes over', async () => {
  const { queueOrder } = await import('../src/queue-order.ts');
  const jobs = [{ id: 'done', state: 'completed' }, { id: 'active', state: 'running' }, { id: 'next', state: 'queued' }];
  jobs.push({ id: 'new', state: 'queued' });
  assert.deepEqual(queueOrder(jobs).map(j => j.id), ['active', 'next', 'new', 'done']);
  jobs[1].state = 'completed';
  jobs[2].state = 'running';
  assert.deepEqual(queueOrder(jobs).map(j => j.id), ['next', 'new', 'active', 'done']);
  assert.equal(jobs[0].id, 'done');
});

test('Shift range includes both ends in either direction and beyond the rendered viewport', async () => {
  const { selectionRange } = await import('../src/file-list.ts');
  const entries = Array.from({length: 100}, (_, i) => ({name: `file-${i}`}));
  assert.deepEqual(selectionRange(entries, 'file-2', 'file-90'), entries.slice(2, 91).map(e => e.name));
  assert.deepEqual(selectionRange(entries, 'file-90', 'file-2'), entries.slice(2, 91).map(e => e.name));
});
