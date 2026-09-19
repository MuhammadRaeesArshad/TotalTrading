import type { Run } from '../types';

/** Status is not money, so it never borrows green or red. */
export function StatusTag({ run }: { run: Run }) {
  if (run.status === 'running' || run.status === 'queued') {
    return <span className="tag hot"><span className="d pulse" />{run.status === 'queued' ? 'queued' : `running ${run.progressPct}%`}</span>;
  }
  if (run.status === 'failed') return <span className="tag" style={{ borderStyle: 'dashed' }}>failed</span>;
  if (run.status === 'cancelled') return <span className="tag">cancelled</span>;
  return <span className="tag">completed</span>;
}
