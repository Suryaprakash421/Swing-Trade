import { useEffect, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  Info,
  Target,
  Trophy,
} from 'lucide-react';
import { api } from './api';
import { retainEqual } from './refresh';
import type { EquityCurve, Stats } from './types';
import {
  CardHeading,
  Empty,
  EquityChart,
  ErrorBox,
  money,
  num,
  PageHeading,
  percent,
  pnlClass,
  signed,
} from './ui';

export default function Insights({
  revision,
  curve,
}: {
  revision: number;
  curve: EquityCurve | null;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [tag, setTag] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = new URLSearchParams({
    ...(tag ? { tag } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }).toString();
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setError('');
      api<Stats>(`/stats?${query}`)
        .then((r) => {
          if (active) setStats((previous) => retainEqual(previous, r));
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, revision]);
  return (
    <>
      <PageHeading
        eyebrow="LET EXPERIENCE BECOME INSIGHT"
        title="Find your own edge."
        description="A thoughtful look at what’s working, and what’s worth refining."
      />
      <div className="insight-filters">
        <label className="field compact-field">
          Setup tag
          <input placeholder="All setups" value={tag} onChange={(e) => setTag(e.target.value)} />
        </label>
        <label className="field compact-field">
          Closed from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field compact-field">
          Closed to
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(tag || from || to) && (
          <button
            className="text-button"
            onClick={() => {
              setTag('');
              setFrom('');
              setTo('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      {error && <ErrorBox message={error} />}
      {!stats ? (
        !error && (
          <div className="loading-block">
            <span className="loader" />
            Connecting the dots…
          </div>
        )
      ) : (
        <>
          <div className="metric-grid insight-metrics">
            <article className="metric-card">
              <span className="metric-label">
                Win rate
                <Target size={17} />
              </span>
              <strong className="metric-value">
                {stats.totalTrades ? percent(stats.winRate) : '—'}
              </strong>
              <div className="metric-bottom">
                <span>
                  {stats.wins} wins · {stats.losses} losses · {stats.breakEven} flat
                </span>
              </div>
            </article>
            <article className="metric-card">
              <span className="metric-label">
                Expectancy per trade
                <ChartNoAxesCombined size={17} />
              </span>
              <strong className={`metric-value ${pnlClass(stats.expectancy)}`}>
                {stats.totalTrades ? signed(stats.expectancy) : '—'}
              </strong>
              <div className="metric-bottom">
                <span>Average net result per closed trade</span>
              </div>
            </article>
            <article className="metric-card">
              <span className="metric-label">
                Profit factor
                <ArrowUpRight size={17} />
              </span>
              <strong className="metric-value">
                {stats.profitFactor == null ? '—' : num(stats.profitFactor).toFixed(2)}
              </strong>
              <div className="metric-bottom">
                <span>Total net wins ÷ total net losses</span>
              </div>
            </article>
            <article className="metric-card">
              <span className="metric-label">
                Max drawdown
                <ArrowDownRight size={17} />
              </span>
              <strong className="metric-value">{percent(stats.maxDrawdown)}</strong>
              <div className="metric-bottom">
                <span>
                  {stats.drawdownBasis === 'FILTERED_CLOSED_TRADES'
                    ? 'Filtered closed-trade P&L drawdown'
                    : 'Daily equity peak to trough'}
                </span>
              </div>
            </article>
          </div>
          <div className="insights-middle">
            <section className="card">
              <CardHeading
                title="Progress, in perspective"
                subtitle="Account equity · daily closing snapshots"
                action={<span className="period-chip">ALL TIME</span>}
              />
              <div className="insights-chart-pad">
                <EquityChart curve={curve} />
              </div>
              <div className="chart-footer">
                <span>
                  <i />
                  Total account equity
                </span>
                <span>Equity curve includes all setups</span>
              </div>
            </section>
            <section className="card stats-breakdown">
              <CardHeading
                title="The details matter"
                subtitle={`${stats.totalTrades} completed ${stats.totalTrades === 1 ? 'trade' : 'trades'}`}
              />
              <dl>
                <div>
                  <dt>Average win</dt>
                  <dd className="positive">{money(stats.averageWin)}</dd>
                </div>
                <div>
                  <dt>Average loss</dt>
                  <dd className="negative">{money(stats.averageLoss)}</dd>
                </div>
                <div>
                  <dt>Average R-multiple</dt>
                  <dd>{stats.averageR == null ? '—' : `${num(stats.averageR).toFixed(2)}R`}</dd>
                </div>
                <div>
                  <dt>Average holding period</dt>
                  <dd>{num(stats.averageHoldingDays).toFixed(1)} days</dd>
                </div>
                <div>
                  <dt>Total completed trades</dt>
                  <dd>{stats.totalTrades}</dd>
                </div>
              </dl>
            </section>
          </div>
          <section className="card">
            <CardHeading
              title="Which setups suit you?"
              subtitle="Let your own history guide your next idea."
            />
            {!stats.byTag.length ? (
              <Empty
                icon={<ChartNoAxesCombined size={25} />}
                title="Your patterns are still taking shape"
                description="Tag your trades with a setup. As they close, you’ll see which ideas are finding their footing."
              />
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Setup</th>
                      <th className="number">Trades</th>
                      <th className="number">Win rate</th>
                      <th className="number">Net P&L</th>
                      <th className="number">Expectancy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byTag.map((row) => (
                      <tr key={row.tag}>
                        <td>
                          <span className="setup-tag">{row.tag || 'Untagged'}</span>
                        </td>
                        <td className="number">{row.totalTrades}</td>
                        <td className="number">{percent(row.winRate)}</td>
                        <td className={`number ${pnlClass(row.netPnl)}`}>{signed(row.netPnl)}</td>
                        <td className={`number ${pnlClass(row.expectancy)}`}>
                          {signed(row.expectancy)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {stats.totalTrades > 0 && (
            <div className="best-worst-grid">
              <section className="card highlight-trade">
                <span className="highlight-icon">
                  <Trophy size={20} />
                </span>
                <div>
                  <span className="section-label">BEST TRADE</span>
                  <h3>{stats.bestTrade?.symbol ?? '—'}</h3>
                  <p className={pnlClass(stats.bestTrade?.netPnl)}>
                    {signed(stats.bestTrade?.netPnl)}
                  </p>
                </div>
              </section>
              <section className="card highlight-trade">
                <span className="highlight-icon muted-icon">
                  <ArrowDownRight size={20} />
                </span>
                <div>
                  <span className="section-label">BIGGEST LESSON</span>
                  <h3>{stats.worstTrade?.symbol ?? '—'}</h3>
                  <p className={pnlClass(stats.worstTrade?.netPnl)}>
                    {signed(stats.worstTrade?.netPnl)}
                  </p>
                </div>
              </section>
            </div>
          )}
          <div className="inline-notice insight-note">
            <Info size={17} />
            <span>
              {stats.totalTrades < 30
                ? `You’re ${stats.totalTrades} trades into your journey. Patterns become more useful after 30+ completed trades.`
                : 'Statistics describe your simulation history, not future returns.'}{' '}
              Break-even trades count in win rate. R uses original entry risk; undefined ratios
              appear as —.
            </span>
          </div>
        </>
      )}
    </>
  );
}
