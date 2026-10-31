import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ChevronDown,
  Clock3,
  Info,
  Search,
  ShieldCheck,
  Target,
  X,
} from 'lucide-react';
import { api, post } from './api';
import type { Account, Instrument, Quote, Trade } from './types';
import { Button, ErrorBox, money, PageHeading } from './ui';
import { estimateTrade } from './tradeEstimate';

export default function TradeForm({
  account,
  onCreated,
}: {
  account: Account;
  onCreated: (trade: Trade) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Instrument[]>([]);
  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [entryType, setEntryType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [quantityMode, setQuantityMode] = useState<'qty' | 'amount'>('qty');
  const [quantity, setQuantity] = useState('');
  const [limit, setLimit] = useState('');
  const [target, setTarget] = useState('');
  const [stop, setStop] = useState('');
  const [tag, setTag] = useState('');
  const [thesis, setThesis] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const idempotency = useRef(crypto.randomUUID());
  useEffect(() => {
    if (instrument) return;
    let active = true;
    const timer = setTimeout(() => {
      setSearching(true);
      setSearchError('');
      api<{ instruments: Instrument[] }>(`/instruments?q=${encodeURIComponent(query)}`)
        .then((r) => {
          if (active) setResults(r.instruments);
        })
        .catch((e) => {
          if (active) setSearchError(e.message);
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, instrument]);
  useEffect(() => {
    if (!instrument) return;
    let active = true;
    setQuoteLoading(true);
    setQuote(instrument.quote);
    const load = () =>
      api<Quote>(`/quotes/${encodeURIComponent(instrument.symbol)}`)
        .then((r) => {
          if (active) {
            setQuote(r);
            setSearchError('');
          }
        })
        .catch((e) => {
          if (active) setSearchError(e.message);
        })
        .finally(() => {
          if (active) setQuoteLoading(false);
        });
    void load();
    const timer = setInterval(load, 20000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [instrument]);
  const estimate = estimateTrade({
    entryType,
    quantityMode,
    quantity,
    quote: quote?.ltp,
    limit,
    target,
    stop,
    tickSize: instrument?.tickSize ?? '.05',
    slippageBps: account.slippageBps,
    reservationBufferBps: account.reservationBufferBps,
    availableCash: account.availableCash,
  });
  const { entry, qty, risk, reward, estimated, validBracket } = estimate;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!instrument || (!quote && (entryType === 'MARKET' || account.marketOpen))) {
      setError('Select an instrument with an available quote before placing a trade.');
      return;
    }
    if (!validBracket) {
      setError('Set your stop below entry and your target above entry.');
      return;
    }
    setBusy(true);
    try {
      const result = await post<{ trade: Trade }>(
        '/trades',
        {
          symbol: instrument.symbol,
          ...(quantityMode === 'qty' ? { qty } : { amount: quantity }),
          entryType,
          ...(entryType === 'LIMIT' ? { limitPrice: limit } : {}),
          targetPrice: target,
          stopPrice: stop,
          setupTag: tag,
          thesis,
        },
        { 'Idempotency-Key': idempotency.current },
      );
      onCreated(result.trade);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow="PLAN BEFORE YOU PLACE"
        title="Give your next idea a plan."
        description="A clear entry, a considered target, and room to learn."
      />
      <form className="trade-layout" onSubmit={submit}>
        <div className="trade-form card">
          <div className="form-section">
            <div className="step-heading">
              <span>01</span>
              <h2>Choose your instrument</h2>
              <span className="muted small">NSE cash equities</span>
            </div>
            {instrument ? (
              <div className="selected-instrument">
                <span className="symbol-avatar large">{instrument.symbol.slice(0, 2)}</span>
                <div>
                  <strong>{instrument.symbol}</strong>
                  <p>{instrument.name}</p>
                </div>
                <div className="selected-price">
                  <strong>{quote ? money(quote.ltp) : '—'}</strong>
                  <small>
                    {quoteLoading
                      ? 'Updating…'
                      : quote
                        ? `${quote.provider === 'fixture' ? 'Test data' : 'Delayed'} · ${new Date(quote.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST`
                        : 'Quote unavailable'}
                  </small>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Change instrument"
                  onClick={() => {
                    setInstrument(null);
                    setQuote(null);
                    setQuery('');
                    setSearchError('');
                  }}
                >
                  <X size={18} />
                </button>
              </div>
            ) : (
              <>
                <label className="search-field">
                  <Search size={18} />
                  <input
                    aria-label="Search NSE instruments"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by symbol or company name"
                    autoComplete="off"
                  />
                </label>
                <div className="instrument-results">
                  {searching ? (
                    <div className="search-message">Finding instruments…</div>
                  ) : results.length ? (
                    results.slice(0, 7).map((i) => (
                      <button
                        type="button"
                        key={i.symbol}
                        onClick={() => {
                          setInstrument(i);
                          setSearchError('');
                        }}
                      >
                        <span className="symbol-avatar">{i.symbol.slice(0, 2)}</span>
                        <span>
                          <strong>{i.symbol}</strong>
                          <small>{i.name}</small>
                        </span>
                        <span className="result-price">
                          {i.quote ? money(i.quote.ltp) : <ArrowRight size={16} />}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="search-message">
                      {query
                        ? 'No instruments found. Try another symbol.'
                        : 'Search for a company to get started.'}
                    </div>
                  )}
                </div>
              </>
            )}
            {searchError && (
              <div className="inline-notice warning">
                <Info size={16} />
                {searchError}
              </div>
            )}
          </div>
          <div className="form-section">
            <div className="step-heading">
              <span>02</span>
              <h2>Set your entry</h2>
            </div>
            <div className="segmented">
              <button
                type="button"
                className={entryType === 'MARKET' ? 'active' : ''}
                onClick={() => setEntryType('MARKET')}
              >
                Market price
              </button>
              <button
                type="button"
                className={entryType === 'LIMIT' ? 'active' : ''}
                onClick={() => setEntryType('LIMIT')}
              >
                Limit price
              </button>
            </div>
            <div className="fields-row">
              {entryType === 'LIMIT' && (
                <label className="field">
                  Limit price{' '}
                  <span className="input-affix">
                    <span>₹</span>
                    <input
                      type="number"
                      required
                      min="0.01"
                      step="0.01"
                      value={limit}
                      onChange={(e) => setLimit(e.target.value)}
                      placeholder="0.00"
                    />
                  </span>
                </label>
              )}
              <label className="field">
                <span className="field-label-row">
                  <span>{quantityMode === 'qty' ? 'Quantity' : 'Investment amount'}</span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setQuantityMode(quantityMode === 'qty' ? 'amount' : 'qty');
                      setQuantity('');
                    }}
                  >
                    {quantityMode === 'qty' ? 'Use ₹ amount' : 'Use shares'}
                  </button>
                </span>
                <span className="input-affix">
                  {quantityMode === 'amount' && <span>₹</span>}
                  <input
                    type="number"
                    required
                    min={quantityMode === 'qty' ? 1 : 0.01}
                    step={quantityMode === 'qty' ? 1 : 0.01}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    placeholder={quantityMode === 'qty' ? 'Number of shares' : 'Amount to invest'}
                  />
                  {quantityMode === 'qty' && <span className="input-suffix">shares</span>}
                </span>
                {quantityMode === 'amount' && (
                  <small>Converted to {qty} whole shares at the current reference price.</small>
                )}
              </label>
            </div>
            {!account.marketOpen && (
              <div className="inline-notice">
                <Clock3 size={16} />
                {account.feed.status === 'CALENDAR_REQUIRED'
                  ? 'A reviewed trading calendar is needed before sessions can be verified. Orders wait until the calendar is configured.'
                  : 'Market is closed. Your order will wait for the next trading session.'}
              </div>
            )}
          </div>
          <div className="form-section">
            <div className="step-heading">
              <span>03</span>
              <h2>Define your boundaries</h2>
            </div>
            <div className="fields-row">
              <label className="field">
                Target price
                <span className="input-affix">
                  <Target size={16} className="positive" />
                  <input
                    type="number"
                    required
                    min="0.01"
                    step="0.01"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder="Your upside"
                  />
                </span>
                <small>Where you plan to take profit.</small>
              </label>
              <label className="field">
                Stop-loss price
                <span className="input-affix">
                  <ShieldCheck size={16} className="negative" />
                  <input
                    type="number"
                    required
                    min="0.01"
                    step="0.01"
                    value={stop}
                    onChange={(e) => setStop(e.target.value)}
                    placeholder="Your safety net"
                  />
                </span>
                <small>Where you protect your capital.</small>
              </label>
            </div>
            <p className="field-footnote">
              Keep target and stop within 50% of entry. Use the instrument’s tick size:{' '}
              {money(instrument?.tickSize ?? '.05')}.
            </p>
          </div>
          <div className="form-section last">
            <div className="step-heading">
              <span>04</span>
              <h2>Leave a note for future you</h2>
              <span className="muted small">Optional</span>
            </div>
            <label className="field">
              Setup tag
              <div className="select-wrap">
                <input
                  list="setup-tags"
                  value={tag}
                  maxLength={60}
                  onChange={(e) => setTag(e.target.value)}
                  placeholder="e.g. Breakout, Pullback, Momentum"
                />
                <ChevronDown size={16} />
                <datalist id="setup-tags">
                  <option value="Breakout" />
                  <option value="Pullback" />
                  <option value="Momentum" />
                  <option value="Support bounce" />
                </datalist>
              </div>
            </label>
            <label className="field">
              Your trading thesis
              <textarea
                value={thesis}
                onChange={(e) => setThesis(e.target.value)}
                maxLength={5000}
                rows={3}
                placeholder="What do you see? What would change your mind?"
              />
            </label>
          </div>
        </div>
        <aside className="trade-summary">
          <div className="card summary-card">
            <div className="summary-icon">
              <ChartPreview />
            </div>
            <h2>Your trade at a glance</h2>
            <p>A little intention goes a long way.</p>
            <dl className="summary-lines">
              <div>
                <dt>Instrument</dt>
                <dd>{instrument?.symbol ?? 'Choose one'}</dd>
              </div>
              <div>
                <dt>Quantity</dt>
                <dd>
                  {qty || '—'} <small>shares</small>
                </dd>
              </div>
              <div>
                <dt>Estimated entry</dt>
                <dd>{estimate.hasEntry ? money(entry) : '—'}</dd>
              </div>
              <div className="summary-total">
                <dt>Estimated investment</dt>
                <dd>{money(estimated)}</dd>
              </div>
            </dl>
            <div className="risk-preview">
              <div>
                <span>
                  <ArrowDown size={14} />
                  Potential risk
                </span>
                <strong className="negative">{money(risk)}</strong>
                <small>{estimate.riskPercent != null ? `${estimate.riskPercent}%` : '—'}</small>
              </div>
              <div>
                <span>
                  <Target size={14} />
                  Potential reward
                </span>
                <strong className="positive">{money(reward)}</strong>
                <small>{estimate.rewardPercent != null ? `${estimate.rewardPercent}%` : '—'}</small>
              </div>
            </div>
            <div className="rr-line">
              <span>Risk : reward</span>
              <strong>{estimate.ratio != null ? `1 : ${estimate.ratio}` : '—'}</strong>
            </div>
            <div className="available-line">
              <span>Available to invest</span>
              <strong>{money(account.availableCash)}</strong>
            </div>
            {estimate.insufficientCash && qty > 0 && (
              <div className="inline-notice warning">
                <Info size={15} />
                Estimated reservation exceeds available cash.
              </div>
            )}
            {error && <ErrorBox message={error} />}
            <Button
              type="submit"
              className="full-width"
              disabled={
                busy ||
                !instrument ||
                (!quote && (entryType === 'MARKET' || account.marketOpen)) ||
                qty < 1
              }
            >
              {busy ? 'Placing your trade…' : 'Place paper trade'}
              {!busy && <ArrowRight size={17} />}
            </Button>
            <p className="summary-disclaimer">
              <ShieldCheck size={14} />
              Virtual capital. Real learning.
            </p>
          </div>
          <div className="trade-tip">
            <span>THE THOUGHTFUL TRADER</span>
            <p>“The goal isn’t to get every trade right. It’s to understand why you took it.”</p>
          </div>
          <div className="data-footnote">
            <Info size={15} />
            <span>
              Prices may be delayed. Orders use simulated fills and 0.05% default slippage. No real
              orders are placed.
            </span>
          </div>
        </aside>
      </form>
    </>
  );
}

function ChartPreview() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
      <path
        d="M4 23L10 16L15 18L25 6M18 6h7v7"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
