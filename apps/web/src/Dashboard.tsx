import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CircleDot,
  Layers3,
  Lightbulb,
  Plus,
  Sprout,
  Wallet,
} from 'lucide-react';
import { percentOf } from './pnl';
import type { Account, EquityCurve, Page, Stats, Trade } from './types';
import {
  Button,
  CardHeading,
  EquityChart,
  money,
  num,
  pnlClass,
  signed,
  signedPercent,
  TradeTable,
} from './ui';

export default function Dashboard({
  account,
  trades,
  curve,
  stats,
  username,
  navigate,
  onSelect,
}: {
  account: Account;
  trades: Trade[];
  curve: EquityCurve | null;
  stats: Stats | null;
  username: string;
  navigate: (p: Page) => void;
  onSelect: (id: string) => void;
}) {
  const active = trades.filter((t) => ['OPEN', 'PENDING'].includes(t.status));
  const open = active.filter((t) => t.status === 'OPEN');
  const pending = active.filter((t) => t.status === 'PENDING');
  const totalPnl = num(account.realisedPnl) + num(account.unrealisedPnl);
  const totalPct = percentOf(totalPnl, account.startingCapital);
  const unrealisedPct = percentOf(account.unrealisedPnl, account.investedValue);
  const realisedPct = percentOf(account.realisedPnl, account.startingCapital);
  const deployedPct = percentOf(account.investedValue, account.equity);
  return (
    <>
      <div className="dashboard-welcome">
        <div>
          <div className="eyebrow">
            <span className="tiny-dot" /> A LITTLE BETTER, EVERY SESSION
          </div>
          <h1>
            A clearer view, <span>{username}.</span>
          </h1>
          <p>Good decisions begin with a little perspective.</p>
        </div>
        <Button onClick={() => navigate('trade')}>
          <Plus size={17} />
          New paper trade
        </Button>
      </div>
      <div className="metric-grid">
        <article className="metric-card equity-metric">
          <div className="metric-label">
            Total equity
            <span className="metric-icon">
              <Wallet size={17} />
            </span>
          </div>
          <strong className="metric-value">{money(account.equity)}</strong>
          <div className="metric-bottom">
            <span className={`metric-delta ${pnlClass(totalPnl)}`}>
              {totalPnl >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
              {signed(totalPnl)} ({signedPercent(totalPct)})
            </span>
            <span>all time</span>
          </div>
          <div className="equity-decoration" aria-hidden="true">
            <svg viewBox="0 0 160 50">
              <path
                d="M0 48L20 39L40 44L60 23L80 30L100 13L120 20L145 1"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-label">
            Available cash
            <span className="metric-icon">
              <ArrowDownLeft size={17} />
            </span>
          </div>
          <strong className="metric-value">{money(account.availableCash)}</strong>
          <div className="metric-bottom">
            <span>
              {num(account.reservedCash)
                ? `${money(account.reservedCash)} reserved for pending orders`
                : num(account.investedValue)
                  ? `${money(account.investedValue)} invested`
                  : 'Ready for your next idea'}
            </span>
            {deployedPct != null && num(account.investedValue) > 0 && (
              <span className="mini-pill">{deployedPct.toFixed(0)}% deployed</span>
            )}
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-label">
            Unrealised P&L
            <span className="metric-icon">
              <Layers3 size={17} />
            </span>
          </div>
          <strong className={`metric-value ${pnlClass(account.unrealisedPnl)}`}>
            {signed(account.unrealisedPnl)}
          </strong>
          <div className="metric-bottom">
            <span className={`metric-delta ${pnlClass(account.unrealisedPnl)}`}>
              {unrealisedPct != null ? `${signedPercent(unrealisedPct)} on invested` : '—'}
            </span>
            <span>
              {open.length} open {open.length === 1 ? 'position' : 'positions'}
            </span>
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-label">
            Realised P&L
            <span className="metric-icon">
              <CircleDot size={17} />
            </span>
          </div>
          <strong className={`metric-value ${pnlClass(account.realisedPnl)}`}>
            {signed(account.realisedPnl)}
          </strong>
          <div className="metric-bottom">
            <span className={`metric-delta ${pnlClass(account.realisedPnl)}`}>
              {realisedPct != null ? `${signedPercent(realisedPct)} of capital` : '—'}
            </span>
            <span>
              {stats?.totalTrades ?? 0} completed{' '}
              {(stats?.totalTrades ?? 0) === 1 ? 'trade' : 'trades'}
            </span>
          </div>
        </article>
      </div>
      <div className="overview-middle">
        <section className="card chart-card">
          <CardHeading
            title="The bigger picture"
            subtitle="Your portfolio’s daily equity, one session at a time."
            action={<span className="period-chip">ALL TIME</span>}
          />
          <div className="chart-headline">
            <strong>{money(account.equity)}</strong>
            <span className={pnlClass(totalPnl)}>
              {signed(totalPnl)} ({signedPercent(totalPct)}){' '}
              <span className="muted">since you started</span>
            </span>
          </div>
          <EquityChart curve={curve} />
          <div className="chart-footer">
            <span>
              <i />
              Total equity
            </span>
            <span>
              {curve?.points.some((p) => p.stale)
                ? 'Includes estimated or stale closing marks'
                : 'Daily snapshots + current mark · IST'}
            </span>
          </div>
        </section>
        <aside className="perspective-card">
          <div className="perspective-icon">
            <Sprout size={25} />
          </div>
          <span className="section-label">A LITTLE PERSPECTIVE</span>
          <h2>
            Build the habit.
            <br />
            The edge will follow.
          </h2>
          <p>Every trade is a chance to learn something about the market — and yourself.</p>
          <div className="learning-step">
            <span>01</span>
            <div>
              <strong>Plan with intention</strong>
              <small>Know your risk before you enter.</small>
            </div>
          </div>
          <div className="learning-step">
            <span>02</span>
            <div>
              <strong>Let the trade play out</strong>
              <small>Give your thesis a fair test.</small>
            </div>
          </div>
          <div className="learning-step">
            <span>03</span>
            <div>
              <strong>Reflect, then refine</strong>
              <small>Your journal is your best teacher.</small>
            </div>
          </div>
          <button className="text-link" onClick={() => navigate('journal')}>
            Spend a moment in your journal
            <ArrowRight size={15} />
          </button>
        </aside>
      </div>
      <section className="card positions-card">
        <CardHeading
          title="Ideas in motion"
          subtitle={`${open.length} open ${open.length === 1 ? 'position' : 'positions'}${pending.length ? ` · ${pending.length} awaiting entry` : ''}`}
          action={
            <button className="text-link" onClick={() => navigate('journal')}>
              View journal
              <ArrowRight size={15} />
            </button>
          }
        />
        <TradeTable
          trades={active}
          onSelect={onSelect}
          emptyAction={
            <Button variant="secondary" onClick={() => navigate('trade')}>
              <Plus size={16} />
              Plan your first trade
            </Button>
          }
        />
      </section>
      <div className="dashboard-footnote">
        <Lightbulb size={17} />
        <p>
          <strong>A thoughtful reminder.</strong> This is a space to practise, not a promise of
          returns. Prices are delayed and execution is simulated.
        </p>
      </div>
    </>
  );
}
