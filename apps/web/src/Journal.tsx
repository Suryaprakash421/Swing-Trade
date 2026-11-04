import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, BookOpen, Search } from 'lucide-react';
import { api } from './api';
import { percentOf, tradeCost, tradePnl } from './pnl';
import { retainEqual } from './refresh';
import type { Trade } from './types';
import {
  Button,
  ErrorBox,
  num,
  PageHeading,
  pnlClass,
  signed,
  signedPercent,
  TradeTable,
} from './ui';

export default function Journal({
  revision,
  onSelect,
  onNew,
}: {
  revision: number;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [status, setStatus] = useState('CLOSED');
  const [symbol, setSymbol] = useState('');
  const [tag, setTag] = useState('');
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const loadedQuery = useRef<string | null>(null);
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (symbol) params.set('symbol', symbol.trim().toUpperCase());
  if (tag) params.set('tag', tag);
  if (reason) params.set('exit_reason', reason);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString();
  const filtered = Boolean(symbol || tag || reason || from || to);
  // Net result of the trades on screen, so a filtered list answers "how did these do?" directly.
  const summary = (() => {
    const measured = trades.filter((t) => tradePnl(t) != null);
    if (!measured.length) return null;
    const pnl = measured.reduce((sum, t) => sum + num(tradePnl(t)), 0);
    const cost = measured.reduce((sum, t) => sum + tradeCost(t), 0);
    const allClosed = measured.every((t) => t.status === 'CLOSED');
    const allOpen = measured.every((t) => t.status === 'OPEN');
    return {
      pnl: pnl.toFixed(2),
      percent: percentOf(pnl, cost),
      label: allClosed ? 'Net P&L' : allOpen ? 'Unrealised P&L' : 'Combined P&L',
    };
  })();
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    // A successful empty result is loaded data too. Revision updates stay silent.
    setLoading(loadedQuery.current !== query);
    const timer = setTimeout(() => {
      setError('');
      api<{ trades: Trade[] }>(`/trades?${query}`, { signal: controller.signal })
        .then((r) => {
          if (active) {
            loadedQuery.current = query;
            setTrades((previous) => retainEqual(previous, r.trades));
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, revision]);
  return (
    <>
      <PageHeading
        eyebrow="LOOK BACK. MOVE FORWARD."
        title="Your trading journal."
        description="Every idea has a story. This is where you learn from yours."
      >
        <a
          className="button button-secondary"
          href={`/api/trades/export.csv?${query}`}
          title="Export completed trades matching your filters"
          download
        >
          <ArrowDownToLine size={17} />
          Export CSV
        </a>
      </PageHeading>
      <section className="card">
        <div className="journal-tabs">
          <button
            className={status === 'CLOSED' ? 'active' : ''}
            onClick={() => setStatus('CLOSED')}
          >
            Completed trades
          </button>
          <button className={status === 'OPEN' ? 'active' : ''} onClick={() => setStatus('OPEN')}>
            Open positions
          </button>
          <button
            className={status === 'PENDING' ? 'active' : ''}
            onClick={() => setStatus('PENDING')}
          >
            Pending orders
          </button>
          <button className={status === '' ? 'active' : ''} onClick={() => setStatus('')}>
            All activity
          </button>
        </div>
        <div className="journal-filters">
          <label className="search-field compact">
            <Search size={16} />
            <input
              aria-label="Filter by symbol"
              placeholder="Symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
            />
          </label>
          <label className="filter-select">
            <span className="sr-only">Setup tag</span>
            <input
              aria-label="Filter by setup tag"
              placeholder="Setup tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            />
          </label>
          <label className="filter-select">
            <span className="sr-only">Exit reason</span>
            <select
              aria-label="Filter by exit reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              <option value="">All exit reasons</option>
              <option value="TARGET">Target hit</option>
              <option value="STOP">Stop hit</option>
              <option value="MANUAL">Manual exit</option>
            </select>
          </label>
          <label className="date-filter">
            <span>From</span>
            <input
              aria-label="From date"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="date-filter">
            <span>To</span>
            <input
              aria-label="To date"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          {(symbol || tag || reason || from || to) && (
            <button
              className="text-button"
              onClick={() => {
                setSymbol('');
                setTag('');
                setReason('');
                setFrom('');
                setTo('');
              }}
            >
              Clear
            </button>
          )}
        </div>
        {error && (
          <div className="card-padding">
            <ErrorBox message={error} />
          </div>
        )}
        {loading ? (
          <div className="loading-block">
            <span className="loader" />
            Gathering your trades…
          </div>
        ) : (
          <>
            <TradeTable
              trades={trades}
              onSelect={onSelect}
              emptyTitle={
                filtered ? 'No trades match these filters' : 'A fresh page, ready for your story'
              }
              emptyDescription={
                filtered
                  ? 'Try a broader date range or clear a filter.'
                  : 'Your trades will appear here as you place and complete them. Add a note to turn each one into a lesson.'
              }
              emptyAction={
                <Button variant="secondary" onClick={onNew}>
                  Plan a paper trade
                  <ArrowRight size={16} />
                </Button>
              }
            />
            {trades.length > 0 && (
              <div className="table-footer">
                <span>
                  {trades.length} {trades.length === 1 ? 'trade' : 'trades'}
                  {summary && (
                    <>
                      {' · '}
                      {summary.label}{' '}
                      <strong className={pnlClass(summary.pnl)}>
                        {signed(summary.pnl)} ({signedPercent(summary.percent)})
                      </strong>
                    </>
                  )}
                </span>
                <span>Amounts in INR · Zero transaction charges</span>
              </div>
            )}
          </>
        )}
      </section>
      <div className="journal-note">
        <BookOpen size={20} />
        <div>
          <strong>Make reflection part of the process.</strong>
          <p>
            Open any trade to review its timeline, revisit your thesis, and leave a note for your
            next session.
          </p>
        </div>
      </div>
    </>
  );
}
