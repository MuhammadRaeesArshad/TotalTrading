import { useMemo } from 'react';
import type { Run, Trade } from '../types';
import { groupBy, verdict, yearOf, type Criterion } from '../stats';
import { fmtMoney, moneyClass } from '../fmt';

/**
 * Did the run clear the bar? Pass/fail is not profit or loss, so it is never
 * green or red: filled marks pass, struck hollow marks fail, dashed ones are
 * unknown. Money figures alone carry colour.
 */
export function VerdictTab({
  run, trades, optimistic, onRunOptimistic, startingOptimistic,
}: {
  run: Run;
  trades: Trade[];
  optimistic: Run | null;
  onRunOptimistic: () => void;
  startingOptimistic: boolean;
}) {
  const criteria = useMemo(() => verdict(run, trades, optimistic), [run, trades, optimistic]);
  const passed = criteria.filter((c) => c.status === 'pass').length;
  const failed = criteria.filter((c) => c.status === 'fail');
  const years = useMemo(
    () => [...groupBy(trades, (t) => String(yearOf(t.exitTime))).values()].sort((a, b) => a.key.localeCompare(b.key)),
    [trades],
  );
  const maxYear = Math.max(...years.map((y) => Math.abs(y.net)), 1);

  return (
    <div className="verdict-grid">
      <div className="card">
        {criteria.map((c) => (
          <Row key={c.id} c={c}>
            {c.id === 'years' && years.length > 0 && (
              <div className="inline" style={{ alignItems: 'flex-end', gap: 12, marginTop: 8 }}>
                {years.map((y) => (
                  <div key={y.key} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <i aria-hidden="true" style={{
                      display: 'block', width: 34, borderRadius: 2,
                      height: Math.max(4, Math.round((Math.abs(y.net) / maxYear) * 30)),
                      ...(y.net >= 0 ? { background: 'var(--gain)' } : { border: '1.5px solid var(--loss)' }),
                    }} />
                    <span className={`mono-sm ${moneyClass(y.net)}`}>{fmtMoney(y.net)}</span>
                    <span className="mono-sm dimmer">{y.key}</span>
                  </div>
                ))}
              </div>
            )}
            {c.id === 'intrabar' && c.status === 'unknown' && (
              <button className="btn2 btn-sm" style={{ marginTop: 8 }} onClick={onRunOptimistic} disabled={startingOptimistic}>
                {startingOptimistic ? 'Starting…' : 'Run the optimistic comparison'}
              </button>
            )}
          </Row>
        ))}
      </div>

      <div className="card verdict-sum">
        <div className="card-b stack">
          <div>
            <p style={{ fontSize: 11.5, color: 'var(--fg-2)', fontWeight: 500 }}>Criteria met</p>
            <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 40, fontWeight: 600, letterSpacing: '-.03em', lineHeight: 1.1, marginTop: 6 }}>
              {passed}<span style={{ fontSize: 17, color: 'var(--fg-3)' }}> / {criteria.length}</span>
            </p>
            <div className="pips" style={{ marginTop: 10 }} aria-hidden="true">
              {criteria.map((c) => <span key={c.id} className={`mk ${c.status}`} />)}
            </div>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
            {failed.length === 0
              ? 'No criterion failed on this run.'
              : failed.length <= 2
                ? `Fails on ${failed.map((c) => c.title.toLowerCase()).join(' and ')}. Read those rows before trusting the headline.`
                : `Fails ${failed.length} criteria. Start with the struck rows before trusting the headline.`}
          </p>
          <p style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.5 }}>
            These are default thresholds. Per-strategy criteria arrive with strategy configs.
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({ c, children }: { c: Criterion; children?: React.ReactNode }) {
  return (
    <div className={`crow ${c.status === 'fail' ? 'fail' : ''}`}>
      <span className={`mk ${c.status}`} role="img" aria-label={c.status === 'pass' ? 'Pass' : c.status === 'fail' ? 'Fail' : 'Not yet known'} style={{ marginTop: 2 }} />
      <div>
        <div className="t">{c.title}</div>
        <div className="why">{c.why}</div>
        {children}
      </div>
      <div className="thr">{c.threshold}</div>
      <div className="act">{c.actual}</div>
    </div>
  );
}
