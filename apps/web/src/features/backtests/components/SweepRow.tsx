import type { Run, Sweep } from '../types';
import { bestRun } from '../group';
import { fmtDate, fmtMoney, fmtR, moneyClass } from '../fmt';
import { Chevron } from './icons';

/**
 * The one line a sweep takes in the list. Collapsed it shows the best result
 * among its runs, which is what you scan a sweep for; open, the runs follow it.
 */
export function SweepRow({ sweep, runs, open, picked, some, onToggle, onPick, onOpenSweep }: {
  sweep: Sweep;
  runs: Run[];
  open: boolean;
  picked: boolean;
  some: boolean;
  onToggle: () => void;
  onPick: () => void;
  onOpenSweep: () => void;
}) {
  const best = bestRun(runs);
  const m = best?.metrics;
  const live = runs.filter((r) => r.status === 'queued' || r.status === 'running');
  const only = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <tr className="sweeprow" onClick={onToggle} tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onToggle()} aria-expanded={open}>
      <td className="pick" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={picked}
          ref={(el) => { if (el) el.indeterminate = some; }}
          aria-label={`Select all ${runs.length} runs of this sweep`}
          onChange={onPick} />
      </td>
      <td>
        <div className="t-name">
          <span className="disclose" aria-hidden><Chevron open={open} /></span>
          Sweep · {sweep.detector} <span className="dimmer mono-sm">v{sweep.detectorVersion ?? '?'}</span>
        </div>
        <div className="t-sub">{sweep.timeframes[0]} · {sweep.symbols.length} pair{sweep.symbols.length === 1 ? '' : 's'}
          {' · '}{fmtDate(sweep.createdAt)} · best of {runs.length} shown</div>
      </td>
      <td className="mono-sm dim">{fmtDate(sweep.fromDate)} – {fmtDate(sweep.toDate)}</td>
      <td>
        {live.length > 0
          ? <span className="tag hot"><span className="d pulse" />{runs.length - live.length}/{runs.length} done</span>
          : <span className="tag">completed</span>}
      </td>
      <td className="r mono-sm dim">{runs.length} runs</td>
      <td className={`r mono-sm ${moneyClass(m?.netProfit)}`}>{m ? fmtMoney(m.netProfit) : '—'}</td>
      <td className="r mono-sm">{m ? (m.profitFactor == null ? '∞' : m.profitFactor.toFixed(2)) : '—'}</td>
      <td className={`r mono-sm ${moneyClass(m?.expectancyR)}`}>{m ? fmtR(m.expectancyR) : '—'}</td>
      <td className="r">
        <div className="row-actions">
          <button className="btn3" onClick={only(onOpenSweep)} title="Compare every setting's effect on one page">
            Open sweep
          </button>
        </div>
      </td>
    </tr>
  );
}
