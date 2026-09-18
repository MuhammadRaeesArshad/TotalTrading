import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Instrument, Mt5Account } from '../lib/types';
import { ago, money, num } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';

const STATE_LABEL: Record<Mt5Account['connectionState'], string> = {
  never_connected: 'Not connected yet',
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Connection failed',
};

function stateClass(s: Mt5Account['connectionState']) {
  if (s === 'connected') return 'tag live';
  if (s === 'error') return 'tag bad';
  return 'tag';
}

export function AccountsPage() {
  const [accounts, setAccounts] = useState<Mt5Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);

  const load = useCallback(async () => {
    try {
      setAccounts(await api.listAccounts());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load accounts.');
      setAccounts([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function connect(account: Mt5Account) {
    setBusyId(account.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.connectAccount(account.id);
      setAccounts((prev) =>
        prev?.map((a) => (a.id === updated.id ? updated : a)) ?? null,
      );
      setNotice(
        `Connected to ${updated.label}. Found ${updated.availableSymbols.length} symbols on this broker.`,
      );
    } catch (err) {
      // The connector's own message is the useful one — MT5 says exactly
      // what it refused and why.
      setError(err instanceof ApiError ? err.message : 'Could not connect.');
      void load();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(account: Mt5Account) {
    if (!confirm(`Remove "${account.label}"? Its stored credentials are deleted too.`)) {
      return;
    }
    setBusyId(account.id);
    try {
      await api.deleteAccount(account.id);
      setAccounts((prev) => prev?.filter((a) => a.id !== account.id) ?? null);
      setNotice(`Removed ${account.label}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove account.');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleInstruments(account: Mt5Account) {
    if (expanded === account.id) {
      setExpanded(null);
      return;
    }
    setExpanded(account.id);
    setInstruments([]);
    try {
      setInstruments(await api.instruments(account.id, true));
    } catch {
      setInstruments([]);
    }
  }

  return (
    <>
      <PageHeader
        title="MT5 accounts"
        lede="Connected terminals, what each holds, and what each is allowed to do."
        actions={
          <button className="btn" onClick={() => setAdding(true)}>
            Add account
          </button>
        }
      />

      {error && <div className="alert err">{error}</div>}
      {notice && <div className="alert ok">{notice}</div>}

      {accounts === null && (
        <div className="card">
          <div className="card-b stack">
            <div className="skel" style={{ width: '40%' }} />
            <div className="skel" style={{ width: '70%' }} />
            <div className="skel" style={{ width: '55%' }} />
          </div>
        </div>
      )}

      {accounts?.length === 0 && (
        <div className="card">
          <div className="empty">
            <h3>No accounts connected</h3>
            <p>
              Add your MT5 login and this app can read balances, symbols and
              price history from your terminal.
            </p>
            <button className="btn" onClick={() => setAdding(true)}>
              Add account
            </button>
          </div>
        </div>
      )}

      <div className="stack">
        {accounts?.map((account) => (
          <div className="card" key={account.id}>
            <div className="card-h">
              <div>
                <h3>{account.label}</h3>
                <p>
                  Login {account.login} · {account.server}
                  {account.broker ? ` · ${account.broker}` : ''}
                </p>
              </div>
              <div className="inline">
                <span className="tag">{account.mode === 'demo' ? 'Demo' : 'Live'}</span>
                <span className={stateClass(account.connectionState)}>
                  <span className="d" />
                  {STATE_LABEL[account.connectionState]}
                </span>
              </div>
            </div>

            <div className="card-b">
              {account.connectionState === 'error' && account.lastError && (
                <div className="alert err">{account.lastError}</div>
              )}

              {account.snapshot ? (
                <div className="grid g4">
                  <div className="metric">
                    <div className="l">Balance</div>
                    <div className="v n">
                      {money(account.snapshot.balance, account.snapshot.currency)}
                    </div>
                  </div>
                  <div className="metric">
                    <div className="l">Equity</div>
                    <div className="v n">
                      {money(account.snapshot.equity, account.snapshot.currency)}
                    </div>
                  </div>
                  <div className="metric">
                    <div className="l">Open profit</div>
                    <div
                      className={`v n ${account.snapshot.profit >= 0 ? 'gain' : 'loss'}`}
                    >
                      {money(account.snapshot.profit, account.snapshot.currency)}
                    </div>
                  </div>
                  <div className="metric">
                    <div className="l">Free margin</div>
                    <div className="v n">
                      {money(account.snapshot.marginFree, account.snapshot.currency)}
                    </div>
                    <div className="s">
                      1:{account.snapshot.leverage} · margin level{' '}
                      {num(account.snapshot.marginLevel, 0)}%
                    </div>
                  </div>
                </div>
              ) : (
                <p className="dim" style={{ fontSize: 13 }}>
                  Connect to read this account's balance and the symbols your
                  broker offers.
                </p>
              )}

              {account.availableSymbols.length > 0 && (
                <div className="row mt16">
                  <span className="k">Symbols on this broker</span>
                  <button
                    className="link"
                    onClick={() => void toggleInstruments(account)}
                  >
                    {account.availableSymbols.length} available
                    {expanded === account.id ? ' — hide' : ' — show forex pairs'}
                  </button>
                </div>
              )}

              {expanded === account.id && (
                <div className="tw mt16">
                  <table>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Pair</th>
                        <th>Class</th>
                        <th className="r">Digits</th>
                        <th className="r">Min lot</th>
                      </tr>
                    </thead>
                    <tbody>
                      {instruments.map((i) => (
                        <tr key={i.id}>
                          <td className="t-name n">{i.symbol}</td>
                          <td className="dim n">{i.normalizedPair ?? '—'}</td>
                          <td>
                            <span className="tag">{i.instrumentClass}</span>
                          </td>
                          <td className="r n">{i.digits ?? '—'}</td>
                          <td className="r n">{i.volumeMin ?? '—'}</td>
                        </tr>
                      ))}
                      {instruments.length === 0 && (
                        <tr>
                          <td colSpan={5} className="dim">
                            No forex pairs stored yet. Connect to fetch them.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="card-f">
              <button
                className="btn btn-sm"
                disabled={busyId === account.id}
                onClick={() => void connect(account)}
              >
                {busyId === account.id ? 'Connecting…' : 'Connect'}
              </button>
              <button
                className="btn2 btn-sm"
                disabled={busyId === account.id || !account.snapshot}
                onClick={async () => {
                  setBusyId(account.id);
                  try {
                    const updated = await api.refreshAccount(account.id);
                    setAccounts((prev) =>
                      prev?.map((a) => (a.id === updated.id ? updated : a)) ?? null,
                    );
                  } catch (err) {
                    setError(
                      err instanceof ApiError ? err.message : 'Could not refresh.',
                    );
                  } finally {
                    setBusyId(null);
                  }
                }}
              >
                Refresh balance
              </button>
              <button
                className="btn-loss btn-sm"
                disabled={busyId === account.id}
                onClick={() => void remove(account)}
              >
                Remove
              </button>
              <span
                className="dimmer"
                style={{ fontSize: 11.5, marginLeft: 'auto', alignSelf: 'center' }}
              >
                Last read {ago(account.lastConnectedAt)} · orders{' '}
                {account.permissions.placeOrders ? 'allowed' : 'off'}
              </span>
            </div>
          </div>
        ))}
      </div>

      <AddAccountModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(account) => {
          setAccounts((prev) => [account, ...(prev ?? [])]);
          setAdding(false);
          setNotice(`Added ${account.label}. Connect it to read the account.`);
        }}
      />
    </>
  );
}

function AddAccountModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (account: Mt5Account) => void;
}) {
  const [form, setForm] = useState({
    label: '', login: '', server: '', password: '', mode: 'demo',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onAdded(await api.createAccount(form));
      setForm({ label: '', login: '', server: '', password: '', mode: 'demo' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Add an MT5 account"
      description="These are the same details you use in the MetaTrader terminal."
      onClose={onClose}
      footer={
        <>
          <button className="btn2" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" onClick={() => void save()} disabled={busy}>
            {busy ? 'Adding…' : 'Add account'}
          </button>
        </>
      }
    >
      {error && <div className="alert err">{error}</div>}

      <div className="f">
        <label htmlFor="label">Name it</label>
        <input
          id="label"
          value={form.label}
          onChange={set('label')}
          placeholder="IC Markets demo"
        />
        <span className="hint">Only you see this. It labels the account in lists.</span>
      </div>

      <div className="f2">
        <div className="f f-mono">
          <label htmlFor="login">Login</label>
          <input id="login" value={form.login} onChange={set('login')} placeholder="51234567" />
        </div>
        <div className="f">
          <label htmlFor="mode">Account type</label>
          <select id="mode" value={form.mode} onChange={set('mode')}>
            <option value="demo">Demo</option>
            <option value="live">Live</option>
          </select>
        </div>
      </div>

      <div className="f f-mono">
        <label htmlFor="server">Server</label>
        <input
          id="server"
          value={form.server}
          onChange={set('server')}
          placeholder="ICMarketsSC-Demo"
        />
        <span className="hint">
          Copy it exactly as the terminal spells it, under File → Login to Trade Account.
        </span>
      </div>

      <div className="f">
        <label htmlFor="mt5pass">Password</label>
        <input
          id="mt5pass"
          type="password"
          value={form.password}
          onChange={set('password')}
        />
        <span className="hint">
          Encrypted before it is stored, and only ever sent to your own MT5
          connector. Use the investor password if you only want read access.
        </span>
      </div>
    </Modal>
  );
}
