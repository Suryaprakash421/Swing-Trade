import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Clock3, Info, ShieldCheck, Target } from 'lucide-react';
import { api, patch, post } from './api';
import { holdingDays, rMultiple, tradeCost, tradePnl, tradeReturnPercent } from './pnl';
import type { Trade, TradeDetail as Detail } from './types';
import { Button, datetime, ErrorBox, Modal, money, PnlValue, Status } from './ui';

export default function TradeDetail({
  id,
  onClose,
  onChanged,
  marketOpen,
}: {
  id: string;
  onClose: () => void;
  onChanged: (message: string) => void;
  marketOpen: boolean;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState('');
  const [stop, setStop] = useState('');
  const [tag, setTag] = useState('');
  const [thesis, setThesis] = useState('');
  const [review, setReview] = useState('');
  const [confirm, setConfirm] = useState<'exit' | 'cancel' | null>(null);
  function load() {
    setError('');
    return api<Detail>(`/trades/${id}`)
      .then((result) => {
        setDetail(result);
        setTarget(Number(result.trade.targetPrice).toFixed(2));
        setStop(Number(result.trade.stopPrice).toFixed(2));
        setTag(result.trade.setupTag);
        setThesis(result.trade.thesis);
        setReview(result.trade.review);
      })
      .catch((e) => setError(e.message));
  }
  useEffect(() => {
    void load();
    let active = true;
    const timer = setInterval(() => {
      void api<Detail>(`/trades/${id}`)
        .then((result) => {
          if (active) setDetail(result);
        })
        .catch(() => {});
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await patch(`/trades/${id}`, {
        ...(detail?.trade.status === 'OPEN' &&
        (Number(target) !== Number(detail.trade.targetPrice) ||
          Number(stop) !== Number(detail.trade.stopPrice))
          ? { targetPrice: target, stopPrice: stop }
          : {}),
        setupTag: tag,
        thesis,
        review,
      });
      await load();
      onChanged('Trade notes and settings saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function act() {
    setBusy(true);
    setError('');
    try {
      await post(`/trades/${id}/${confirm}`, {});
      await load();
      onChanged(
        confirm === 'exit'
          ? 'Trade closed. Your journal is up to date.'
          : 'Pending order cancelled. Reserved cash released.',
      );
      setConfirm(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const t = detail?.trade;
  const pnl = t ? tradePnl(t) : null;
  const held = t ? holdingDays(t) : null;
  return (
    <Modal title={t ? `${t.symbol} · Trade journal` : 'Trade journal'} onClose={onClose} wide>
      {error && <ErrorBox message={error} retry={detail ? undefined : () => void load()} />}
      {!detail ? (
        !error && (
          <div className="loading-block">
            <span className="loader" />
            Opening your trade…
          </div>
        )
      ) : (
        <>
          <div className="detail-overview">
            <div className="detail-symbol">
              <span className="symbol-avatar large">{t!.symbol.slice(0, 2)}</span>
              <div>
                <strong>{t!.symbol}</strong>
                <p>
                  {t!.qty} shares · {t!.entryType.toLowerCase()} entry
                </p>
              </div>
            </div>
            <Status status={t!.status} />
          </div>
          <div className="detail-metrics">
            <div>
              <span>Entry price</span>
              <strong>{t!.entryPrice ? money(t!.entryPrice) : 'Awaiting fill'}</strong>
            </div>
            <div>
              <span>{t!.status === 'CLOSED' ? 'Exit price' : 'Last price'}</span>
              <strong>
                {t!.status === 'CLOSED'
                  ? money(t!.exitPrice)
                  : t!.quote
                    ? money(t!.quote.ltp)
                    : '—'}
              </strong>
            </div>
            <div>
              <span>{t!.status === 'CLOSED' ? 'Net P&L' : 'Unrealised P&L'}</span>
              <PnlValue
                pnl={pnl}
                returnPercent={tradeReturnPercent(t!)}
                r={rMultiple(pnl, t!.initialRisk)}
                size="detail"
              />
            </div>
          </div>
          <dl className="detail-facts">
            <div>
              <dt>Invested</dt>
              <dd>{tradeCost(t!) ? money(tradeCost(t!)) : '—'}</dd>
            </div>
            <div>
              <dt>Initial risk</dt>
              <dd>{t!.initialRisk ? money(t!.initialRisk) : '—'}</dd>
            </div>
            <div>
              <dt>{t!.status === 'CLOSED' ? 'Held for' : 'Holding'}</dt>
              <dd>{held == null ? '—' : `${held} ${held === 1 ? 'day' : 'days'}`}</dd>
            </div>
            <div>
              <dt>Exit reason</dt>
              <dd>
                {t!.exitReason
                  ? t!.exitReason.charAt(0) + t!.exitReason.slice(1).toLowerCase()
                  : '—'}
              </dd>
            </div>
          </dl>
          {t!.rejectionReason && (
            <div className="inline-notice warning">
              <Info size={16} />
              {t!.rejectionReason}
            </div>
          )}
          {t!.recoveryPaused && (
            <RecoveryPanel
              trade={t!}
              onReconciled={() => {
                void load();
                onChanged('Recovery decision recorded in your trade timeline.');
              }}
            />
          )}
          {t!.inferred && (
            <div className="inline-notice">
              <Info size={16} />
              This trade includes an estimated candle-based fill. Exact intraminute execution could
              not be verified.
            </div>
          )}
          {t!.gapFill && (
            <div className="inline-notice">
              <Info size={16} />
              Filled through a session-opening gap.
            </div>
          )}
          <form onSubmit={save}>
            <div className="fields-row">
              <label className="field">
                Target price
                <span className="input-affix">
                  <Target size={16} />
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    disabled={t!.status !== 'OPEN'}
                    required
                  />
                </span>
              </label>
              <label className="field">
                Stop-loss price
                <span className="input-affix">
                  <ShieldCheck size={16} />
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={stop}
                    onChange={(e) => setStop(e.target.value)}
                    disabled={t!.status !== 'OPEN'}
                    required
                  />
                </span>
              </label>
            </div>
            {t!.status === 'OPEN' && (
              <p className="field-footnote">
                Changes are recorded in your timeline. A stop above entry is allowed to protect a
                profit.
              </p>
            )}
            <label className="field">
              Setup tag
              <input
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                maxLength={60}
                placeholder="e.g. Breakout"
              />
            </label>
            <label className="field">
              Original thesis
              <textarea
                value={thesis}
                onChange={(e) => setThesis(e.target.value)}
                maxLength={5000}
                rows={3}
                placeholder="What was the idea behind this trade?"
              />
            </label>
            <label className="field">
              {t!.status === 'CLOSED' ? 'Post-trade reflection' : 'Your reflections'}
              <textarea
                value={review}
                onChange={(e) => setReview(e.target.value)}
                maxLength={5000}
                rows={3}
                placeholder="What worked? What will you do differently next time?"
              />
            </label>
            <div className="detail-actions">
              <Button disabled={busy} type="submit">
                <Check size={16} />
                {busy ? 'Saving…' : 'Save changes'}
              </Button>
              {t!.status === 'OPEN' && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConfirm('exit')}
                  disabled={busy || !marketOpen}
                >
                  Exit trade
                  <ArrowRight size={15} />
                </Button>
              )}
              {t!.status === 'PENDING' && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConfirm('cancel')}
                  disabled={busy}
                >
                  Cancel order
                </Button>
              )}
            </div>
            {t!.status === 'OPEN' && !marketOpen && (
              <p className="field-footnote">
                Manual exits are available during a market session with a usable quote.
              </p>
            )}
          </form>
          {confirm && (
            <div className="confirm-panel">
              <strong>
                {confirm === 'exit'
                  ? 'Close this trade at the current available price?'
                  : 'Cancel this pending order?'}
              </strong>
              <p>
                {confirm === 'exit'
                  ? 'The exit is simulated with configured slippage and added to your journal.'
                  : 'Your reserved cash will be released. No position will be opened.'}
              </p>
              <div className="button-row">
                <Button variant="danger" disabled={busy} onClick={act}>
                  {busy
                    ? 'Processing…'
                    : confirm === 'exit'
                      ? 'Confirm exit'
                      : 'Confirm cancellation'}
                </Button>
                <Button variant="ghost" onClick={() => setConfirm(null)}>
                  Keep trade
                </Button>
              </div>
            </div>
          )}
          <section className="timeline-section">
            <h3>
              <Clock3 size={17} />
              The story of this trade
            </h3>
            <div className="timeline">
              {detail.events.length ? (
                detail.events.map((event) => (
                  <div className="timeline-item" key={event.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>
                        {event.type
                          .replaceAll('_', ' ')
                          .toLowerCase()
                          .replace(/^./, (s) => s.toUpperCase())}
                      </strong>
                      {event.price && <span className="timeline-price">{money(event.price)}</span>}
                      <small>Market time: {datetime(event.effectiveAt)} IST</small>
                      {Math.abs(
                        new Date(event.createdAt).getTime() - new Date(event.effectiveAt).getTime(),
                      ) > 1000 && <small>Recorded: {datetime(event.createdAt)} IST</small>}
                      {typeof event.payload?.reason === 'string' && <p>{event.payload.reason}</p>}
                    </div>
                  </div>
                ))
              ) : (
                <p className="muted">Events will appear as this trade progresses.</p>
              )}
            </div>
          </section>
          <div className="detail-footer">
            <span>Created {datetime(t!.createdAt)} IST</span>
            <span>Charges {money(t!.charges)}</span>
          </div>
        </>
      )}
    </Modal>
  );
}

function RecoveryPanel({ trade, onReconciled }: { trade: Trade; onReconciled: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [action, setAction] = useState<'resume' | 'close'>('resume');
  const [price, setPrice] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function reconcile(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post(`/trades/${trade.id}/reconcile`, {
        confirm: 'RECONCILE',
        action,
        ...(action === 'close' ? { exitPrice: price } : {}),
      });
      onReconciled();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="recovery-panel">
      <div className="inline-notice warning">
        <Info size={16} />
        <span>
          <strong>Review needed.</strong>{' '}
          {trade.recoveryMessage ||
            'Automatic processing is paused because market history is incomplete.'}
        </span>
      </div>
      {!expanded ? (
        <Button variant="secondary" onClick={() => setExpanded(true)}>
          Review recovery options
        </Button>
      ) : (
        <form onSubmit={reconcile}>
          <p>
            Review the missing interval using your own market records. Resuming skips unverified
            history; closing records a manual, estimated outcome.
          </p>
          <label className="field">
            Your decision
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as 'resume' | 'close')}
            >
              <option value="resume">Acknowledge the gap and resume from now</option>
              {trade.status === 'OPEN' && (
                <option value="close">Record a manually reconciled exit price</option>
              )}
            </select>
          </label>
          {action === 'close' && (
            <label className="field">
              Reconciled exit price
              <input
                type="number"
                min="0.01"
                step="0.01"
                required
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Price from your own records"
              />
            </label>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              required
            />
            <span>I reviewed the gap and understand that exact execution cannot be verified.</span>
          </label>
          {error && <ErrorBox message={error} />}
          <div className="button-row">
            <Button disabled={!acknowledged || busy} type="submit">
              {busy ? 'Recording decision…' : 'Confirm reconciliation'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setExpanded(false)}>
              Keep paused
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
