import type { TransferJob } from '../shared/types';

/** Running first, waiting in enqueue order, then newest finished operations. */
export function queueOrder(jobs: TransferJob[]): TransferJob[] {
  return [
    ...jobs.filter((job) => job.state === 'running'),
    ...jobs.filter((job) => job.state === 'queued'),
    ...jobs.filter((job) => job.state !== 'running' && job.state !== 'queued').reverse(),
  ];
}
