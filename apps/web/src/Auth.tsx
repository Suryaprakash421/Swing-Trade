import { useId, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  ChartNoAxesCombined,
  Eye,
  EyeOff,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { post } from './api';
import type { Auth as AuthData } from './types';
import { Brand, Button, ErrorBox } from './ui';

export default function Auth({ onSuccess }: { onSuccess: (auth: AuthData) => void }) {
  const [create, setCreate] = useState(false);
  const [visible, setVisible] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = useId();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (create && password !== confirm) {
      setError('Your passwords do not match. Please check and try again.');
      return;
    }
    setBusy(true);
    try {
      onSuccess(
        await post<AuthData>(`/auth/${create ? 'register' : 'login'}`, {
          username: username.trim(),
          password,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-story">
        <Brand light />
        <div className="auth-story-body">
          <span className="auth-kicker">
            <span className="tiny-dot" /> A LITTLE PRACTICE. A LOT OF PERSPECTIVE.
          </span>
          <h1>
            Good ideas deserve
            <br />a <em>practice run.</em>
          </h1>
          <p>
            A calmer space to test your trading instincts.
            <br />
            Build conviction, one paper trade at a time.
          </p>
          <div className="auth-illustration" aria-hidden="true">
            <div className="illustration-grid" />
            <div className="floating-note note-one">
              <span className="note-icon">
                <ChartNoAxesCombined size={20} />
              </span>
              <span>
                Your strategy.<small>Room to grow.</small>
              </span>
              <ArrowRight size={17} />
            </div>
            <svg viewBox="0 0 500 200">
              <path
                d="M0 180 L50 170 L90 183 L140 110 L190 128 L235 105 L285 120 L335 47 L380 65 L430 35 L500 12"
                fill="none"
                stroke="#d9e998"
                strokeWidth="3"
                strokeLinejoin="round"
              />
              <path
                d="M0 180 L50 170 L90 183 L140 110 L190 128 L235 105 L285 120 L335 47 L380 65 L430 35 L500 12 L500 200 L0 200Z"
                fill="url(#auth-fill)"
              />
              <defs>
                <linearGradient id="auth-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop stopColor="#d9e998" stopOpacity=".18" />
                  <stop offset="1" stopColor="#d9e998" stopOpacity="0" />
                </linearGradient>
              </defs>
            </svg>
            <div className="floating-note note-two">
              <span className="mini-leaf">↗</span>
              <span>
                Confidence, built daily.<small>Practice with perspective.</small>
              </span>
            </div>
          </div>
          <div className="auth-benefits">
            <span>
              <Check size={15} /> ₹1 lakh virtual capital
            </span>
            <span>
              <Check size={15} /> Zero charges
            </span>
            <span>
              <Check size={15} /> Your private portfolio
            </span>
          </div>
        </div>
        <div className="auth-story-footer">
          Made for thoughtful traders. <span>NSE EQUITIES · PAPER ONLY</span>
        </div>
      </section>
      <section className="auth-form-side">
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-form-wrap">
          <span className="section-label">
            <Sparkles size={15} /> YOUR NEXT CHAPTER
          </span>
          <h2>{create ? 'A fresh start awaits.' : 'Welcome back.'}</h2>
          <p>
            {create
              ? 'Create your account. Give your ideas a place to grow.'
              : 'Your ideas, your progress, your own little edge.'}
          </p>
          <div className="auth-tabs" aria-label="Authentication options">
            <button
              className={!create ? 'active' : ''}
              onClick={() => {
                setCreate(false);
                setError('');
              }}
            >
              Log in
            </button>
            <button
              className={create ? 'active' : ''}
              onClick={() => {
                setCreate(true);
                setError('');
              }}
            >
              Create account
            </button>
          </div>
          <form onSubmit={submit}>
            {error && <ErrorBox message={error} />}
            <div className="field">
              <label htmlFor={`${ids}-username`}>Username</label>
              <input
                id={`${ids}-username`}
                autoComplete="username"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                minLength={3}
                maxLength={30}
                pattern="[A-Za-z0-9_]+"
                placeholder="Your username"
                aria-describedby={create ? `${ids}-username-hint` : undefined}
                autoFocus
              />
              {create && (
                <small id={`${ids}-username-hint`}>3–30 letters, numbers, or underscores.</small>
              )}
            </div>
            <label className="field">
              Password
              <div className="password-field">
                <input
                  type={visible ? 'text' : 'password'}
                  name="password"
                  autoComplete={create ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={create ? 12 : undefined}
                  maxLength={128}
                  placeholder={create ? 'At least 12 characters' : 'Your password'}
                />
                <button
                  type="button"
                  aria-label={visible ? 'Hide password' : 'Show password'}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            {create && (
              <label className="field">
                Confirm password
                <input
                  type={visible ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  minLength={12}
                  maxLength={128}
                  required
                  placeholder="One more time"
                />
              </label>
            )}
            <Button type="submit" className="auth-submit" disabled={busy}>
              {busy ? 'One moment…' : create ? 'Create your account' : 'Step into your portfolio'}
              {!busy && <ArrowRight size={18} />}
            </Button>
          </form>
          <div className="auth-private">
            <ShieldCheck size={17} />
            <span>
              Your portfolio stays yours.
              <br />
              <small>No real money. No real orders. Just practice.</small>
            </span>
          </div>
        </div>
        <div className="auth-bottom-note">Delayed market data · Simulated execution</div>
      </section>
    </main>
  );
}
