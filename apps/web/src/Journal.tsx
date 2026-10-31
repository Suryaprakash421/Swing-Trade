import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowRight, BookOpen, ChevronRight, Search } from 'lucide-react';
import { api } from './api';
import type { Trade } from './types';
import {
  Button,
  datetime,
  Empty,
  ErrorBox,
  money,
  PageHeading,
  pnlClass,
  signed,
  Status,
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
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (symbol) params.set('symbol', symbol.trim().toUpperCase());
  if (tag) params.set('tag', tag);
  if (reason) params.set('exit_reason', reason);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString();
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setLoading(true);
      setError('');
      api<{ trades: Trade[] }>(`/trades?${query}`)
        .then((r) => {
          if (active) setTrades(r.trades);
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
        ) : !trades.length ? (
          <Empty
            icon={<BookOpen size={25} />}
            title={
              symbol || tag || reason || from || to
                ? 'No trades match these filters'
                : 'A fresh page, ready for your story'
            }
            description={
              symbol || tag || reason || from || to
                ? 'Try a broader date range or clear a filter.'
                : 'Your trades will appear here as you place and complete them. Add a note to turn each one into a lesson.'
            }
            action={
              <Button variant="secondary" onClick={onNew}>
                Plan a paper trade
                <ArrowRight size={16} />
              </Button>
            }
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table journal-table">
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Status</th>
                    <th>Dates · IST</th>
                    <th className="number">Entry</th>
                    <th className="number">Exit</th>
                    <th className="number">Net P&L</th>
                    <th>Exit reason</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} onClick={() => onSelect(t.id)}>
                      <td>
                        <button className="instrument-cell" onClick={() => onSelect(t.id)}>
                          <span className="symbol-avatar">{t.symbol.slice(0, 2)}</span>
                          <span>
                            <strong>{t.symbol}</strong>
                            <small>
                              {t.qty} shares{t.setupTag ? ` · ${t.setupTag}` : ''}
                            </small>
                          </span>
                        </button>
                      </td>
                      <td>
                        <Status status={t.status} />
                      </td>
                      <td>
                        <span>{datetime(t.entryAt ?? t.createdAt, true)}</span>
                        {t.exitAt && <small>to {datetime(t.exitAt, true)}</small>}
                      </td>
                      <td className="number">{t.entryPrice ? money(t.entryPrice) : '—'}</td>
                      <td className="number">{t.exitPrice ? money(t.exitPrice) : '—'}</td>
                      <td className={`number ${pnlClass(t.netPnl)}`}>
                        {t.netPnl != null ? signed(t.netPnl) : '—'}
                      </td>
                      <td>
                        <span className={`exit-reason ${(t.exitReason ?? '').toLowerCase()}`}>
                          {t.exitReason === 'TARGET'
                            ? 'Target hit'
                            : t.exitReason === 'STOP'
                              ? 'Stop hit'
                              : t.exitReason === 'MANUAL'
                                ? 'Manual'
                                : '—'}
                        </span>
                        {t.inferred && <small>Estimated fill</small>}
                      </td>
                      <td>
                        <ChevronRight size={16} className="muted" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-footer">
              <span>
                {trades.length} {trades.length === 1 ? 'trade' : 'trades'}
              </span>
              <span>Amounts in INR · Zero transaction charges</span>
            </div>
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
