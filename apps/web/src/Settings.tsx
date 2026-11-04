import { useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  CircleCheck,
  LockKeyhole,
  LogOut,
  RefreshCcw,
  ShieldCheck,
  User,
  Wallet,
} from 'lucide-react';
import { patch, post } from './api';
import type { Account } from './types';
import { Button, ErrorBox, money, PageHeading } from './ui';

export default function Settings({
  account,
  username,
  onChanged,
  onLogout,
}: {
  account: Account;
  username: string;
  onChanged: (message: string) => void;
  onLogout: () => void;
}) {
  const [capital, setCapital] = useState(account.startingCapital);
  const [slippage, setSlippage] = useState(String(account.slippageBps / 100));
  const [days, setDays] = useState(String(account.limitValidityDays));
  const [confirm, setConfirm] = useState('');
  const [showReset, setShowReset] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setCapital(account.startingCapital);
    setSlippage(String(account.slippageBps / 100));
    setDays(String(account.limitValidityDays));
  }, [account.startingCapital, account.slippageBps, account.limitValidityDays]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await patch('/account/settings', {
        ...(Number(capital) !== Number(account.startingCapital)
          ? { startingCapital: capital }
          : {}),
        slippageBps: Math.round(Number(slippage) * 100),
        limitValidityDays: Number(days),
      });
      onChanged('Your account settings have been saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    setError('');
    try {
      await post('/account/reset', { confirm });
      setConfirm('');
      setShowReset(false);
      onChanged('Your account has a fresh start. Other users are unaffected.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="MAKE THIS SPACE YOURS"
        title="A few thoughtful settings."
        description="Keep your practice aligned with the way you want to trade."
      />
      <div className="settings-layout">
        <div>
          <section className="card settings-card">
            <div className="settings-section-heading">
              <span className="settings-section-icon">
                <User size={21} />
              </span>
              <div>
                <h2>Your private account</h2>
                <p>Separate by design. Yours to learn from.</p>
              </div>
            </div>
            <div className="profile-summary">
              <span className="profile-avatar">{username.slice(0, 2).toUpperCase()}</span>
              <div>
                <strong>{username}</strong>
                <span>Individual paper trading account</span>
              </div>
              <span className="mini-pill">
                <LockKeyhole size={12} /> Private
              </span>
            </div>
            <p className="settings-description">
              Your trades, notes, cash, and statistics are visible only to your account. Logging out
              closes your current session on this device.
            </p>
            <Button variant="secondary" type="button" onClick={onLogout}>
              <LogOut size={16} />
              Log out
            </Button>
          </section>
          <section className="card settings-card">
            <div className="settings-section-heading">
              <span className="settings-section-icon">
                <Wallet size={21} />
              </span>
              <div>
                <h2>Simulation preferences</h2>
                <p>Simple defaults, room to adjust.</p>
              </div>
            </div>
            <form onSubmit={save}>
              {error && !showReset && <ErrorBox message={error} />}
              <label className="field">
                Starting capital
                <span className="input-affix">
                  <span>₹</span>
                  <input
                    type="number"
                    min="1000"
                    max="1000000000"
                    step="0.01"
                    value={capital}
                    onChange={(e) => setCapital(e.target.value)}
                    required
                  />
                </span>
                <small>
                  Editable before placing your first trade. To change later, reset your account
                  first.
                </small>
              </label>
              <div className="fields-row">
                <label className="field">
                  Simulated slippage
                  <span className="input-affix">
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={slippage}
                      onChange={(e) => setSlippage(e.target.value)}
                      required
                    />
                    <span className="input-suffix">%</span>
                  </span>
                  <small>Adverse price adjustment for market-like fills.</small>
                </label>
                <label className="field">
                  Limit order validity
                  <span className="input-affix">
                    <input
                      type="number"
                      min="1"
                      max="30"
                      step="1"
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                      required
                    />
                    <span className="input-suffix">sessions</span>
                  </span>
                  <small>Pending limits expire at session close.</small>
                </label>
              </div>
              <div className="zero-charge-card">
                <span className="zero-charge-icon">
                  <Check size={18} />
                </span>
                <div>
                  <strong>Zero transaction charges</strong>
                  <p>No brokerage, STT, exchange fees, GST, stamp duty, or DP charges.</p>
                </div>
                <span>₹0</span>
              </div>
              <Button type="submit" disabled={busy}>
                <Check size={16} />
                {busy ? 'Saving…' : 'Save preferences'}
              </Button>
            </form>
          </section>
          <section className="card settings-card reset-card">
            <div className="settings-section-heading">
              <span className="settings-section-icon">
                <RefreshCcw size={21} />
              </span>
              <div>
                <h2>A fresh page</h2>
                <p>Sometimes a clean slate is part of the process.</p>
              </div>
            </div>
            <p className="settings-description">
              Resetting clears your trades, journal, equity history, and pending orders, then
              restores your configured starting capital of {money(account.startingCapital)}. Your
              login and preferences stay intact. Other users’ accounts are unaffected.
            </p>
            {!showReset ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setShowReset(true);
                  setError('');
                }}
              >
                Reset my virtual account
              </Button>
            ) : (
              <div className="confirm-panel">
                {error && <ErrorBox message={error} />}
                <label className="field">
                  Type RESET to confirm
                  <input
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="RESET"
                    autoComplete="off"
                  />
                </label>
                <div className="button-row">
                  <Button variant="danger" disabled={confirm !== 'RESET' || busy} onClick={reset}>
                    {busy ? 'Resetting…' : 'Confirm account reset'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setShowReset(false);
                      setConfirm('');
                    }}
                  >
                    Keep my history
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
        <aside className="settings-aside">
          <ShieldCheck size={27} />
          <h3>Practice with clarity.</h3>
          <p>Paperlane is a simulator. It doesn’t connect to your bank or place real orders.</p>
          <div>
            <CircleCheck size={16} />
            <span>NSE cash equities, long only</span>
          </div>
          <div>
            <CircleCheck size={16} />
            <span>Delayed market prices</span>
          </div>
          <div>
            <CircleCheck size={16} />
            <span>Target and stop-loss exits</span>
          </div>
          <div>
            <CircleCheck size={16} />
            <span>Conservative recovery estimates</span>
          </div>
          <hr />
          <p className="small">
            Telegram alerts are off by default. Enabling them requires a verified recipient for your
            account through the server operator.
          </p>
          <p className="small">
            Lost your password? Contact your server operator for a controlled reset.
          </p>
        </aside>
      </div>
    </>
  );
}
