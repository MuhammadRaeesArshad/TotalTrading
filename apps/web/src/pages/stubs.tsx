import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { ComingSoon } from '../components/ComingSoon';

/**
 * Pages whose backing data genuinely does not exist yet. Each says what will
 * land there and what has to happen first.
 *
 * Summary, Strategies and Jobs used to live here claiming they were blocked on
 * a strategy definition and a job queue. Both had since been built, so the
 * pages were lying about the system to the person who built it. They are real
 * pages now. Anything left in this file is blocked on data nothing writes or
 * an endpoint nothing serves — check that before adding to it.
 */

export function PositionsPage() {
  return (
    <>
      <PageHeader
        title="Positions"
        lede="Open trades across every account, straight from the MT5 bridge."
      />
      <ComingSoon
        title="Open trades, read from your terminal"
        planned={[
          'Live open positions with floating P&L',
          'Which signal, if any, opened each one',
          'Closed-trade reconciliation against MT5 history',
        ]}
        blockedOn={
          <>
            Needs <code>/positions</code> and <code>/history</code> on the MT5
            connector, which today serves only <code>/account</code>,{' '}
            <code>/symbols</code> and <code>/candles</code>. Nothing this system
            places orders either — execution stays off until live and backtest
            results have been cross-checked on a demo account.
          </>
        }
      >
        This will show what is open right now, whether the system placed it or
        you did by hand.
      </ComingSoon>
    </>
  );
}

export function AnalysisPage() {
  return (
    <>
      <PageHeader
        title="AI analysis"
        lede="Reports written by the model on your machine, from your own trade data."
      />
      <ComingSoon
        title="Plain-language commentary on finished runs"
        planned={[
          'A written read on every completed backtest',
          'Where a strategy is making and losing its money',
          'Reports kept against the run that produced them',
        ]}
        blockedOn={
          <>
            The <code>ai-analysis</code> service is built and exposes{' '}
            <code>POST /analyze</code>, but the gateway has no route through to
            it — only a health probe. It needs one route and somewhere to keep
            what comes back. Commentary is attached to a finished result and is
            never a step in producing one, so nothing else waits on this.
          </>
        }
      >
        Everything the model reads stays on this machine, and so does everything
        it writes.
      </ComingSoon>
    </>
  );
}

export function JournalPage() {
  return (
    <>
      <PageHeader
        title="Journal"
        lede="Every trade, from the simulator and from you, with whatever notes you add."
      />
      <ComingSoon
        title="One row per trade, however it was opened"
        planned={[
          'Manual and simulated trades on the same axes',
          'Tag trades and write notes against them',
          'R-multiple and expectancy over any date range',
        ]}
        blockedOn={
          <>
            Needs MT5 history reconciliation to import trades you took by hand,
            and somewhere to store a note against one. For simulated trades{' '}
            <Link className="link" to="/explore">Explore</Link> already answers the
            aggregate question across every run at once.
          </>
        }
      >
        The trade schema is already in place and handles backtested, manual and
        automated trades identically.
      </ComingSoon>
    </>
  );
}

export function LogsPage() {
  return (
    <>
      <PageHeader title="System logs" lede="Raw output from each service, newest first." />
      <ComingSoon
        title="A live tail from every service"
        planned={['Filter by service and level', 'Follow a scan while it runs']}
        blockedOn={
          <>
            The <code>system_logs</code> collection is defined in the gateway's
            schemas, but no service writes to it and no route reads it. Service
            reachability is on <Link className="link" to="/">Summary</Link> today.
          </>
        }
      >
        For now, read the logs where each service runs — the connector prints to
        its own console on the Windows box.
      </ComingSoon>
    </>
  );
}
