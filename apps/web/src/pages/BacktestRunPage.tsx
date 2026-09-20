import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { backtestApi } from '../features/backtests/api';
import { useRun, useTrades } from '../features/backtests/hooks';
import type { Run } from '../features/backtests/types';
import { fmtDate, fmtMoney, fmtPct, fmtR, moneyClass } from '../features/backtests/fmt';
import { deployedCapital } from '../features/backtests/stats';
import { TradesTab } from '../features/backtests/components/TradesTab';
import { VerdictTab } from '../features/backtests/components/VerdictTab';
import { LedgerTab } from '../features/backtests/components/LedgerTab';
import { ReplayTab } from '../features/backtests/components/ReplayTab';
import { AnatomyTab } from '../features/backtests/components/AnatomyTab';
import { StatusTag } from '../features/backtests/components/StatusTag';

const TABS = [
  { id: 'trades', label: 'Trades' },
  { id: 'verdict', label: 'Verdict' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'replay', label: 'Replay' },
  { id: 'anatomy', label: 'Anatomy' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** How the balance was spread, said plainly: a per-pair run deploys a multiple of it. */
function capitalLabel(run: Run) {
  const each = `$${run.initialBalance.toLocaleString()}`;
  return run.capital === 'per_symbol'
    ? `${each} per pair · $${deployedCapital(run).toLocaleString()} deployed`
    : `${each} shared`;
}

/** Same detector, rules, pairs, timeframe, window and capital — differing only in the intrabar policy. */
function isOptimisticTwin(a: Run, b: Run) {
  return b._id !== a._id && b.status === 'completed' && b.intrabarPolicy === 'optimistic' &&
    (b.capital ?? 'shared') === (a.capital ?? 'shared') &&
    b.detector === a.detector && b.detectorVersion === a.detectorVersion &&
    b.timeframes[0] === a.timeframes[0] && b.fromDate === a.fromDate && b.toDate === a.toDate &&
    [...b.symbols].sort().join() === [...a.symbols].sort().join();
}

export function BacktestRunPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { run, error } = useRun(id);
  const { trades, error: tradesError } = useTrades(run);
  const [twin, setTwin] = useState<Run | null>(null);
  const [startingTwin, setStartingTwin] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'trades') as TabId;
  const tradeId = params.get('trade');

  const setTab = (t: TabId) => setParams((p) => { p.set('tab', t); return p; }, { replace: true });
  const selectTrade = useCallback(
    (tid: string) => setParams((p) => { p.set('trade', tid); return p; }, { replace: true }),
    [setParams],
  );
  const openTrade = (tid: string) => setParams((p) => { p.set('tab', 'trades'); p.set('trade', tid); return p; });

  // Find the optimistic twin, if one has been run, for the Verdict's robustness
  // row. `run` stops changing once it completes (polling ends), so this runs once.
  useEffect(() => {
    if (run?.status !== 'completed' || run.intrabarPolicy !== 'pessimistic') return;
    backtestApi.runs().then((all) => setTwin(all.find((r) => isOptimisticTwin(run, r)) ?? null)).catch(() => undefined);
  }, [run]);

  async function runTwin() {
    if (!run) return;
    setStartingTwin(true);
    setActionError(null);
    try {
      const twinRun = await backtestApi.start({
        detector: run.detector,
        symbols: run.symbols,
        timeframe: run.timeframes[0],
        higherTimeframes: run.timeframes.slice(1),
        fromTs: Math.floor(Date.parse(run.fromDate) / 1000),
        toTs: Math.floor(Date.parse(run.toDate) / 1000),
        sim: {
          riskPercent: run.riskPercentPerTrade, initialBalance: run.initialBalance,
          capital: run.capital ?? 'shared', intrabar: 'optimistic',
        },
      });
      navigate(`/backtests/${twinRun._id}`);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not start the comparison run.');
    } finally {
      setStartingTwin(false);
    }
  }

  async function remove() {
    if (!run || !window.confirm('Delete this backtest and all its trades? This cannot be undone.')) return;
    try {
      await backtestApi.remove(run._id);
      navigate('/backtests');
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not delete this backtest.');
    }
  }

  const title = run ? `${run.detector} v${run.detectorVersion ?? '?'} · ${run.timeframes[0]} · ${run.symbols.length} pair${run.symbols.length === 1 ? '' : 's'}` : 'Backtest';

  return (
    <>
      <PageHeader
        title={title}
        lede={run ? `${fmtDate(run.fromDate)} – ${fmtDate(run.toDate)} · ${run.riskPercentPerTrade}% risk · ${capitalLabel(run)} · ${run.intrabarPolicy} intrabar` : undefined}
        actions={<>
          <Link to="/backtests" className="btn2" style={{ textDecoration: 'none' }}>All backtests</Link>
          {run && <button className="btn-loss" onClick={remove}>Delete</button>}
        </>}
      />
      {run && (
        <div className="meta">
          <span>Pairs <b>{run.symbols.join(' ')}</b></span>
          {run.engineVersion && <span>Engine <b>{run.engineVersion}</b></span>}
          {run.status === 'completed' && <span>Scanned <b>{run.barsProcessed.toLocaleString()}</b> bars in <b>{run.elapsedMs} ms</b></span>}
          {run.rulesSnapshot && Object.keys(run.rulesSnapshot).length > 0 && (
            <span>Settings {Object.entries(run.rulesSnapshot).map(([k, v]) => (
              <b key={k} style={{ marginRight: 8 }}>{k.replace(/_/g, ' ')} {String(v)}</b>
            ))}</span>
          )}
          <StatusTag run={run} />
        </div>
      )}

      {params.get('reused') === '1' && (
        <div className="alert">
          This exact backtest had already been run — same strategy, settings, pairs, window and
          costs — so these are its stored results rather than a fresh computation. Change any of
          them and it runs for real.
        </div>
      )}
      {(error || actionError || tradesError) && <div className="alert err">{error || actionError || tradesError}</div>}
      {!run && !error && <div className="card card-b"><div className="skel" style={{ width: '40%' }} /></div>}

      {run && (run.status === 'queued' || run.status === 'running') && (
        <div className="card card-b stack">
          <div className="spread"><span>Scanning {run.symbols.length} pairs…</span><span className="mono-sm">{run.progressPct}%</span></div>
          <div className="bar"><i style={{ width: `${run.progressPct}%` }} /></div>
        </div>
      )}

      {run?.status === 'failed' && (
        <div className="alert err">This run failed: {run.error ?? 'no reason given'}.</div>
      )}

      {run?.status === 'completed' && run.metrics && <StatsStrip run={run} />}

      {run?.status === 'completed' && (
        <>
          <div className="tabs2" role="tablist" aria-label="Views">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {!trades && !tradesError && <div className="card card-b"><div className="skel" style={{ width: '50%' }} /></div>}
          {trades && trades.length === 0 && (
            <div className="card empty"><h3>No trades</h3><p>The detector found no setups that became trades in this window. The skipped counts above say why signals were dropped.</p></div>
          )}
          {trades && trades.length > 0 && (
            <>
              {tab === 'trades' && <TradesTab run={run} trades={trades} selectedId={tradeId} onSelect={selectTrade} />}
              {tab === 'verdict' && <VerdictTab run={run} trades={trades} optimistic={twin} onRunOptimistic={runTwin} startingOptimistic={startingTwin} />}
              {tab === 'ledger' && <LedgerTab run={run} trades={trades} onOpen={openTrade} />}
              {tab === 'replay' && <ReplayTab run={run} trades={trades} onOpen={openTrade} />}
              {tab === 'anatomy' && <AnatomyTab trades={trades} initialBalance={deployedCapital(run)} />}
            </>
          )}
        </>
      )}
    </>
  );
}

/** The run's headline numbers, from the engine. Signals explains the gap to trades. */
function StatsStrip({ run }: { run: Run }) {
  const m = run.metrics!;
  const sk = run.skipped;
  const skipped = sk
    ? sk.maxOpen + sk.stopGapped + (sk.targetPassed ?? 0) + sk.stopInsideCosts + sk.belowMinVolume + sk.noEntryBar
    : 0;
  const skipNote = sk
    ? [
        sk.maxOpen && `${sk.maxOpen} pair full`,
        sk.stopGapped && `${sk.stopGapped} gapped past stop`,
        sk.targetPassed && `${sk.targetPassed} gapped past target`,
        sk.stopInsideCosts && `${sk.stopInsideCosts} stop in spread`,
        sk.belowMinVolume && `${sk.belowMinVolume} too small`,
      ].filter(Boolean).join(' · ')
    : '';
  const cells = [
    { l: 'Net', v: fmtMoney(m.netProfit), c: moneyClass(m.netProfit), s: `$${Math.round(m.finalEquity).toLocaleString()} final` },
    { l: 'Trades', v: String(m.totalTrades), s: `${m.wins} won · ${m.losses} lost` },
    { l: 'Win rate', v: fmtPct(m.winRate / 100), s: `${m.ambiguousExits} decided by tie-break` },
    { l: 'Profit factor', v: m.profitFactor == null ? '∞' : m.profitFactor.toFixed(2), s: 'gross won ÷ gross lost' },
    { l: 'Expectancy', v: fmtR(m.expectancyR), c: moneyClass(m.expectancyR), s: 'average trade' },
    { l: 'Max drawdown', v: `${m.maxDrawdownPct.toFixed(1)}%`, s: `$${Math.round(m.maxDrawdown).toLocaleString()} from peak` },
    { l: 'Signals', v: String(run.signalsGenerated), s: skipped ? `${skipped} skipped${skipNote ? ` — ${skipNote}` : ''}` : 'all became trades' },
  ];
  return (
    <div className="strip">
      {cells.map((c) => (
        <div key={c.l}><div className="l">{c.l}</div><div className={`v ${c.c ?? ''}`}>{c.v}</div><div className="s">{c.s}</div></div>
      ))}
    </div>
  );
}
