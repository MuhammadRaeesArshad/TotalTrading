import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import type { Instrument, Mt5Account } from '../../../lib/types';
import { Modal } from '../../../components/Modal';
import { backtestApi } from '../api';
import type { ImportReport } from '../types';
import { fmtDate } from '../fmt';

const TIMEFRAMES = ['M15', 'M30', 'H1', 'H4', 'D1'];

/**
 * Pulls price history out of MetaTrader into the engine's bar cache. Runs
 * against one of your stored accounts — the gateway decrypts its login for the
 * length of the import and nothing else sees it.
 */
export function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [accounts, setAccounts] = useState<Mt5Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [timeframes, setTimeframes] = useState<string[]>(['H1', 'H4']);
  const [fromYear, setFromYear] = useState(new Date().getUTCFullYear() - 5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  useEffect(() => {
    if (!open) return;
    setReport(null);
    setError(null);
    api.listAccounts()
      .then((list) => {
        setAccounts(list);
        setAccountId((cur) => cur || list[0]?.id || '');
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load your MT5 accounts.'));
  }, [open]);

  useEffect(() => {
    if (!accountId) return;
    api.instruments(accountId, true)
      .then((list) => {
        setInstruments(list);
        setSymbols(list.filter((i) => i.instrumentClass === 'major' || i.instrumentClass === 'minor').map((i) => i.symbol));
      })
      .catch(() => setInstruments([]));
  }, [accountId]);

  const byClass = useMemo(() => {
    const out: Record<string, Instrument[]> = { major: [], minor: [] };
    for (const i of instruments) if (out[i.instrumentClass]) out[i.instrumentClass].push(i);
    return out;
  }, [instruments]);

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const years = Array.from({ length: 16 }, (_, i) => new Date().getUTCFullYear() - i);

  async function submit() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const r = await backtestApi.importHistory(accountId, {
        symbols,
        timeframes,
        fromTs: Math.floor(Date.UTC(fromYear, 0, 1) / 1000),
        toTs: Math.floor(Date.now() / 1000),
      });
      setReport(r);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The import failed.');
    } finally {
      setBusy(false);
    }
  }

  const series = symbols.length * timeframes.length;

  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose}
      title="Import price history"
      description="Pulls candles from your MetaTrader terminal into the backtest cache. The terminal must be open and logged in."
      footer={<>
        <button className="btn2" onClick={onClose} disabled={busy}>{report ? 'Close' : 'Cancel'}</button>
        <button className="btn" onClick={submit} disabled={busy || !accountId || !series}>
          {busy ? 'Importing… this can take minutes' : `Import ${series} series`}
        </button>
      </>}>
      {error && <div className="alert err">{error}</div>}
      {accounts.length === 0 && !error && <div className="alert">Add an MT5 account on the Accounts page first.</div>}

      {report ? (
        <div className="stack">
          <div className="alert ok">Imported {report.total_bars.toLocaleString()} bars in {(report.elapsed_ms / 1000).toFixed(1)}s.</div>
          <div className="tw">
            <table className="tl">
              <thead><tr><th>Pair</th><th>TF</th><th className="r">Bars</th><th>From</th><th>Note</th></tr></thead>
              <tbody>
                {report.imported.map((s) => (
                  <tr key={`${s.symbol}${s.timeframe}`} style={{ cursor: 'default' }}>
                    <td>{s.symbol}</td><td className="mono-sm">{s.timeframe}</td>
                    <td className="r mono-sm">{s.bars.toLocaleString()}</td>
                    <td className="mono-sm">{s.first_ts ? fmtDate(new Date(s.first_ts * 1000).toISOString()) : '—'}</td>
                    <td className="dim" style={{ whiteSpace: 'normal', fontSize: 11.5 }}>{s.short_of_request ? 'Terminal history starts later than asked' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.failed.length > 0 && (
            <div className="alert err">
              {report.failed.length} failed: {report.failed.map((f) => `${f.symbol} ${f.timeframe} (${f.error})`).join('; ')}
            </div>
          )}
        </div>
      ) : (
        <div className="stack">
          <div className="f">
            <label htmlFor="imp-acc">Account</label>
            <select id="imp-acc" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={busy}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.login} ({a.mode})</option>)}
            </select>
          </div>

          <div className="f">
            <label>Pairs · {symbols.length} selected</label>
            {(['major', 'minor'] as const).map((cls) => (
              <div key={cls}>
                <div className="spread" style={{ margin: '6px 0 4px' }}>
                  <span className="dim" style={{ fontSize: 11.5 }}>{cls === 'major' ? 'Majors' : 'Minors'}</span>
                  <button type="button" className="btn3" onClick={() => {
                    const all = byClass[cls].map((i) => i.symbol);
                    const has = all.every((s) => symbols.includes(s));
                    setSymbols(has ? symbols.filter((s) => !all.includes(s)) : [...new Set([...symbols, ...all])]);
                  }}>toggle all</button>
                </div>
                <div className="inline" style={{ gap: 6 }}>
                  {byClass[cls].map((i) => (
                    <label key={i.symbol} className="tag" style={{ cursor: 'pointer', ...(symbols.includes(i.symbol) ? { color: 'var(--fg)', borderColor: 'var(--line-strong)', background: 'var(--surface-3)' } : {}) }}>
                      <input type="checkbox" checked={symbols.includes(i.symbol)} onChange={() => setSymbols(toggle(symbols, i.symbol))}
                        style={{ margin: 0 }} disabled={busy} />
                      {i.symbol}
                    </label>
                  ))}
                  {byClass[cls].length === 0 && <span className="dimmer" style={{ fontSize: 12 }}>None found. Reconnect the account to refresh its symbols.</span>}
                </div>
              </div>
            ))}
          </div>

          <div className="f2">
            <div className="f">
              <label>Timeframes</label>
              <div className="inline" style={{ gap: 6 }}>
                {TIMEFRAMES.map((tf) => (
                  <label key={tf} className="tag" style={{ cursor: 'pointer', ...(timeframes.includes(tf) ? { color: 'var(--fg)', borderColor: 'var(--line-strong)', background: 'var(--surface-3)' } : {}) }}>
                    <input type="checkbox" checked={timeframes.includes(tf)} onChange={() => setTimeframes(toggle(timeframes, tf))} style={{ margin: 0 }} disabled={busy} />
                    {tf}
                  </label>
                ))}
              </div>
              <span className="hint">Your strategy will need H4 and H1 for trend, M30 and M15 for entries.</span>
            </div>
            <div className="f">
              <label htmlFor="imp-from">From</label>
              <select id="imp-from" value={fromYear} onChange={(e) => setFromYear(Number(e.target.value))} disabled={busy}>
                {years.map((y) => <option key={y} value={y}>1 Jan {y}</option>)}
              </select>
              <span className="hint">The terminal may hold less. The report says how far back each pair reached.</span>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
