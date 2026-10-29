import type { TransferJob } from '../shared/types';

/** Average throughput since this run started; timestamps are Unix milliseconds. */
export function transferEstimate(job: TransferJob, now: number): string {
  if (job.state !== 'running') return '';
  const elapsed = job.startedAt ? (now - job.startedAt) / 1000 : 0;
  if (job.total === null || job.total <= 0 || job.bytes <= 0 || elapsed < 1)
    return 'Estimating time left…';
  if (job.bytes >= job.total) return 'Finishing…';
  const seconds = Math.ceil((job.total - job.bytes) / (job.bytes / elapsed));
  if (seconds < 60) return `About ${seconds}s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `About ${minutes}m left`;
  return `About ${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}
