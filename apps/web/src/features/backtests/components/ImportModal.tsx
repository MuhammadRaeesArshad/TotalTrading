import { useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import type { Instrument, Mt5Account } from '../../../lib/types';
import { Modal } from '../../../components/Modal';
import { backtestApi } from '../api';
import { PairPicker } from './PairPicker';

const TIMEFRAMES = ['M15', 'M30', 'H1', 'H4', 'D1'];

/**
 * Pulls price history out of MetaTrader into the engine's bar cache. Runs
 * against one of your stored accounts — the gateway decrypts its login for the
 * length of the import and nothing else sees it.
 */
export function ImportModal({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: () => void }) {
  const [accounts, setAccounts] = useState<Mt5Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [timeframes, setTimeframes] = useState<string[]>(['H1', 'H4']);
  const [fromYear, setFromYear] = useState(new Date().getUTCFullYear() - 5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
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

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const years = Array.from({ length: 16 }, (_, i) => new Date().getUTCFullYear() - i);

  // Starts the import and closes: it runs in the engine's background, and its
  // progress shows on the Backtests page rather than in a dialog held open.
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await backtestApi.importHistory(accountId, {
        symbols,
        timeframes,
        fromTs: Math.floor(Date.UTC(fromYear, 0, 1) / 1000),
        toTs: Math.floor(Date.now() / 1000),
      });
      onStarted();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The import could not start.');
    } finally {
      setBusy(false);
    }
  }

  const series = symbols.length * timeframes.length;

  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose}
      title="Import price history"
      description="Pulls candles from your MetaTrader terminal into the backtest cache. Runs in the background — you can close this and keep working. The terminal must be open and logged in."
      footer={<>
        <button className="btn2" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" onClick={submit} disabled={busy || !accountId || !series}>
          {busy ? 'Starting…' : `Import ${series} series`}
        </button>
      </>}>
      {error && <div className="alert err">{error}</div>}
      {accounts.length === 0 && !error && <div className="alert">Add an MT5 account on the Accounts page first.</div>}

        <div className="stack">
          <div className="f">
            <label htmlFor="imp-acc">Account</label>
            <select id="imp-acc" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={busy}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.login} ({a.mode})</option>)}
            </select>
          </div>

          <PairPicker available={instruments.map((i) => i.symbol)} selected={symbols}
            onChange={setSymbols} disabled={busy} />

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
    </Modal>
  );
}
