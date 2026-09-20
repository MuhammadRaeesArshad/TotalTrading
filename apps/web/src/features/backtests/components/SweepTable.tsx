import type { Sweep, SweepCell } from '../types';
import { fmtMoney, fmtR, moneyClass } from '../fmt';
import { StatusTag } from './StatusTag';

/**
 * A sweep, one row per setting value.
 *
 * Grouped by axis so each block reads as "what this one knob does", which is
 * the question one-at-a-time sweeping exists to answer. Cells with no run yet
 * are shown as queued rather than hidden, so the shape of the whole sweep is
 * visible from the moment it starts.
 */
export function SweepTable({ sweep, onOpen }: { sweep: Sweep; onOpen: (runId: string) => void }) {
  const axes = new Map<string, SweepCell[]>();
  for (const cell of sweep.cells) {
    const list = axes.get(cell.axis) ?? [];
    list.push(cell);
    axes.set(cell.axis, list);
  }

  return (
    <div className="stack">
      {[...axes].map(([axis, cells]) => (
        <div className="card" key={axis}>
          <div className="card-h"><h3 style={{ margin: 0 }}>{axis}</h3></div>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Value</th><th>Status</th>
                  <th className="r">Trades</th><th className="r">Net</th>
                  <th className="r">Profit factor</th><th className="r">Expectancy</th>
                </tr>
              </thead>
              <tbody>
                {cells.map((cell, i) => {
                  const m = cell.run?.metrics;
                  const open = () => cell.runId && onOpen(cell.runId);
                  return (
                    <tr key={`${axis}-${i}`} onClick={open}
                      style={{ cursor: cell.runId ? 'pointer' : 'default' }}>
                      <td className="mono-sm">{String(cell.value)}</td>
                      <td>{cell.run ? <StatusTag run={cell.run} /> : <span className="tag">queued</span>}</td>
                      <td className="r mono-sm">{m ? m.totalTrades : '—'}</td>
                      <td className={`r mono-sm ${moneyClass(m?.netProfit)}`}>{m ? fmtMoney(m.netProfit) : '—'}</td>
                      <td className="r mono-sm">{m ? (m.profitFactor == null ? '∞' : m.profitFactor.toFixed(2)) : '—'}</td>
                      <td className={`r mono-sm ${moneyClass(m?.expectancyR)}`}>{m ? fmtR(m.expectancyR) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
