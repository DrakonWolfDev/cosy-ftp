const { test } = require('node:test');
const assert = require('node:assert/strict');

const estimate = import('../src/transfer-estimate.ts');
const job = { state: 'running', startedAt: 1000, total: 1000, bytes: 250 };

test('time remaining uses elapsed throughput and rounds to readable units', async () => {
  const { transferEstimate } = await estimate;
  assert.equal(transferEstimate(job, 11000), 'About 30s left');
  assert.equal(transferEstimate(job, 61000), 'About 3m left');
  assert.equal(transferEstimate(job, 1201000), 'About 1h 0m left');
});

test('unknown totals and startup wait for progress; completed bytes show finishing', async () => {
  const { transferEstimate } = await estimate;
  for (const change of [{ total: null }, { total: 0 }, { bytes: 0 }, { startedAt: undefined }])
    assert.equal(transferEstimate({ ...job, ...change }, 11000), 'Estimating time left…');
  assert.equal(transferEstimate(job, 1500), 'Estimating time left…');
  assert.equal(transferEstimate({ ...job, bytes: 1000 }, 11000), 'Finishing…');
  assert.equal(transferEstimate({ ...job, state: 'queued' }, 11000), '');
});
