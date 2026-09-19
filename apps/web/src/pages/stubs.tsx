import { PageHeader } from '../components/PageHeader';
import { ComingSoon } from '../components/ComingSoon';

/**
 * Pages whose backing services aren't built yet. Each says what will land
 * there and what has to happen first, so the nav isn't full of dead ends.
 */

const STRATEGY_BLOCKER = (
  <>
    Blocked on the strategy definition. The detection rules are being rewritten,
    and building against a placeholder would put guessed logic into both the
    live scanner and the backtester at once.
  </>
);

export function SummaryPage() {
  return (
    <>
      <PageHeader
        title="Summary"
        lede="Live performance across every bot you have running."
      />
      <ComingSoon
        title="Your running strategies, at a glance"
        planned={[
          'Equity and open profit across every connected account',
          'Which pairs are in a setup right now, and on which timeframe',
          'Today against your rolling average',
        ]}
        blockedOn={STRATEGY_BLOCKER}
      >
        There is nothing to summarise until a strategy is scanning. Connect an
        MT5 account first — that part works today.
      </ComingSoon>
    </>
  );
}

export function StrategiesPage() {
  return (
    <>
      <PageHeader
        title="Strategies"
        lede="Your rule sets and their settings. Deploy one to an account and it becomes a bot."
      />
      <ComingSoon
        title="Rule sets you can edit and deploy"
        planned={[
          'Define entry, stop and target rules per timeframe',
          'Pick which pairs each set runs against',
          'Version rules so old signals stay readable',
        ]}
        blockedOn={STRATEGY_BLOCKER}
      >
        The database already stores strategies and versions their rules. What is
        missing is the rules themselves.
      </ComingSoon>
    </>
  );
}

export function PositionsPage() {
  return (
    <>
      <PageHeader
        title="Positions"
        lede="Open trades across every bot and account, straight from the MT5 bridge."
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
            connector. The connector currently reads accounts, symbols and
            candles.
          </>
        }
      >
        This will show what is open right now, whether the system placed it or
        you did by hand.
      </ComingSoon>
    </>
  );
}

export function JobsPage() {
  return (
    <>
      <PageHeader
        title="Jobs"
        lede="Background work: live scans, backtests, history syncs, and analysis runs."
      />
      <ComingSoon
        title="What the system is chewing on"
        planned={[
          'Progress and queue depth per job',
          'Cancel a run that is going nowhere',
          'Failures with the error that caused them',
        ]}
        blockedOn="Needs the Redis job queue and the scanner that feeds it."
      >
        Scans and backtests will queue here, with progress you can watch and
        stop.
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
          'Later: news read alongside the session filter',
        ]}
        blockedOn={
          <>
            Needs Ollama running locally against the RX 9060 XT, and a backtest
            worth writing about. The model summarises computed results — it is
            never asked to find patterns in raw candles.
          </>
        }
      >
        Everything the model reads stays on this machine, and so does
        everything it writes.
      </ComingSoon>
    </>
  );
}

export function JournalPage() {
  return (
    <>
      <PageHeader
        title="Journal"
        lede="Every trade, from bots and from you, with whatever notes you add."
      />
      <ComingSoon
        title="One row per trade, however it was opened"
        planned={[
          'Manual and automated trades on the same axes',
          'Tag trades and write notes against them',
          'R-multiple and expectancy over any date range',
        ]}
        blockedOn="Needs MT5 history reconciliation to import trades you took by hand."
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
        planned={[
          'Filter by service and level',
          'Follow a scan while it runs',
        ]}
        blockedOn="Needs services to ship logs into the capped log collection."
      >
        For now, read the logs where each service runs — the connector prints to
        its own console on the Windows box.
      </ComingSoon>
    </>
  );
}
