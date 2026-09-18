import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ServicesStatus } from '../lib/types';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../lib/auth';

const SERVICE_NOTES: Record<string, string> = {
  'api-gateway': 'Auth, REST, and the only service the browser talks to.',
  mongodb: 'Accounts, strategies, signals, backtests and the journal.',
  'mt5-connector': 'The bridge to MetaTrader. Runs on your Windows machine.',
  'strategy-engine': 'Scans pairs for setups. Waiting on the strategy rules.',
  'backtest-engine': 'Replays history at speed. Built; waiting on rules.',
  'ai-analysis': 'Local model writing commentary on finished runs.',
};

export function SettingsPage() {
  const { user } = useAuth();
  const [services, setServices] = useState<ServicesStatus | null>(null);

  useEffect(() => {
    api.services().then(setServices).catch(() => setServices({}));
  }, []);

  return (
    <>
      <PageHeader
        title="Settings"
        lede="Your account, service health, and the guardrails this build ships with."
      />

      <div className="grid g2">
        <div className="card">
          <div className="card-h">
            <div>
              <h3>Service health</h3>
              <p>What is running right now.</p>
            </div>
          </div>
          <div className="card-b tight">
            {services === null && <div className="skel" style={{ width: '60%' }} />}
            {services &&
              Object.entries(services).map(([name, status]) => (
                <div className="row" key={name}>
                  <div>
                    <div>{name}</div>
                    <div className="dimmer" style={{ fontSize: 11.5 }}>
                      {SERVICE_NOTES[name] ?? ''}
                    </div>
                  </div>
                  <span
                    className={
                      status.reachable
                        ? status.mode === 'mock'
                          ? 'tag hot'
                          : 'tag live'
                        : 'tag'
                    }
                  >
                    <span className="d" />
                    {!status.reachable
                      ? status.status === 'not_implemented' || status.status === 'awaiting_strategy'
                        ? 'Not built'
                        : 'Unreachable'
                      : status.mode === 'mock'
                        ? 'Mock data'
                        : 'Running'}
                  </span>
                </div>
              ))}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <div>
              <h3>Guardrails</h3>
              <p>Fixed in this build. They open up in later phases.</p>
            </div>
          </div>
          <div className="card-b tight">
            <div className="swr">
              <div>
                <div className="t">Place orders</div>
                <div className="d">
                  Stays off until backtest and live results have been checked
                  against each other on a demo account.
                </div>
              </div>
              <div className="sw" aria-disabled="true" />
            </div>
            <div className="swr">
              <div>
                <div className="t">Read market data</div>
                <div className="d">Candles and symbols from your terminal.</div>
              </div>
              <div className="sw on" aria-disabled="true" />
            </div>
            <div className="swr">
              <div>
                <div className="t">Keep everything local</div>
                <div className="d">
                  Prices, credentials and the model never leave this machine.
                </div>
              </div>
              <div className="sw on" aria-disabled="true" />
            </div>
          </div>
        </div>
      </div>

      <div className="card mt16">
        <div className="card-h">
          <div>
            <h3>Your account</h3>
          </div>
        </div>
        <div className="card-b tight">
          <div className="row">
            <span className="k">Name</span>
            <span>{user?.displayName}</span>
          </div>
          <div className="row">
            <span className="k">Email</span>
            <span className="n">{user?.email}</span>
          </div>
          <div className="row">
            <span className="k">Role</span>
            <span>{user?.role}</span>
          </div>
        </div>
      </div>
    </>
  );
}
