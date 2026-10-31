import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ArrowUpRight, ChevronRight, CircleHelp, Leaf, X } from 'lucide-react';
import type { EquityCurve, Trade } from './types';

export const num = (value: unknown) => Number(value ?? 0);
export const money = (value: unknown, decimals = 2) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num(value));
export const signed = (value: unknown) => `${num(value) > 0 ? '+' : ''}${money(value)}`;
export const percent = (value: unknown, digits = 1) => `${num(value).toFixed(digits)}%`;
export const datetime = (value: string | null, short = false) =>
  value
    ? new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        ...(short ? {} : { year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      }).format(new Date(value))
    : '—';
export const pnlClass = (value: unknown) =>
  num(value) < 0 ? 'negative' : num(value) > 0 ? 'positive' : 'muted';

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <span className={`brand ${light ? 'light' : ''}`}>
      <span className="brand-mark">
        <Leaf size={22} strokeWidth={1.8} />
      </span>
      paperlane<span className="brand-dot">.</span>
    </span>
  );
}
export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <button className={`button button-${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <CircleHelp size={18} />
      <span>{message}</span>
      {retry && <button onClick={retry}>Try again</button>}
    </div>
  );
}
export function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${status.toLowerCase()}`}>
      <i />
      {status === 'OPEN'
        ? 'Open'
        : status === 'PENDING'
          ? 'Pending'
          : status === 'CLOSED'
            ? 'Closed'
            : status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}
export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
export function CardHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card-heading">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-labelledby={id}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={id}>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={21} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function EquityChart({
  curve,
  compact = false,
}: {
  curve: EquityCurve | null;
  compact?: boolean;
}) {
  const points = curve?.points ?? [];
  const hasHistory = points.length > 0;
  const base = num(curve?.initialCapital ?? 100000);
  const values = points.map((p) => num(p.equity));
  const all = values.length ? [base, ...values] : [base, base];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = Math.max((max - min) * 0.24, max * 0.015, 100);
  const lo = min - pad;
  const hi = max + pad;
  const width = 760;
  const height = compact ? 180 : 230;
  const bottom = height - 22;
  const left = 16;
  const right = width - 16;
  const plotted = values.length === 1 ? [base, ...values] : values.length ? values : [base, base];
  const coords = plotted.map((v, i) => [
    left + (i / Math.max(plotted.length - 1, 1)) * (right - left),
    bottom - ((v - lo) / (hi - lo)) * (bottom - 18),
  ]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ');
  const area = `${line} L ${right} ${bottom} L ${left} ${bottom} Z`;
  const gradient = useId().replaceAll(':', '');
  return (
    <div className={`equity-chart ${!hasHistory ? 'chart-awaiting' : ''}`}>
      <div className="chart-y-labels">
        {[hi, (hi + lo) / 2, lo].map((v, i) => (
          <span key={i}>{money(v, 0)}</span>
        ))}
      </div>
      <div className="chart-drawing">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={
            hasHistory
              ? 'Daily account equity in rupees'
              : 'Starting capital. Daily equity history appears after a completed session.'
          }
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#18735c" stopOpacity=".16" />
              <stop offset="100%" stopColor="#18735c" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[24, height / 2, bottom].map((y) => (
            <line
              key={y}
              x1={left}
              y1={y}
              x2={right}
              y2={y}
              stroke="#e9ece6"
              strokeDasharray="4 5"
            />
          ))}
          <path d={area} fill={`url(#${gradient})`} />
          <path
            d={line}
            stroke="#23765e"
            fill="none"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={hasHistory ? undefined : '7 6'}
            vectorEffect="non-scaling-stroke"
          />
          {hasHistory && (
            <circle
              cx={coords.at(-1)?.[0]}
              cy={coords.at(-1)?.[1]}
              r="4"
              fill="#18735c"
              stroke="white"
              strokeWidth="2"
            />
          )}
        </svg>
        <div className="chart-x-labels">
          <span>{hasHistory ? datetime(points[0]!.date, true) : 'Starting point'}</span>
          <span>
            {hasHistory && points.length > 1
              ? datetime(points.at(-1)!.date, true)
              : 'Your next chapter'}
          </span>
        </div>
      </div>
      {!hasHistory && (
        <div className="chart-empty-label">
          <span className="tiny-dot" /> Your equity story starts here
        </div>
      )}
    </div>
  );
}

export function PositionsTable({
  trades,
  onSelect,
  emptyAction,
}: {
  trades: Trade[];
  onSelect: (id: string) => void;
  emptyAction?: ReactNode;
}) {
  if (!trades.length)
    return (
      <Empty
        icon={<ArrowUpRight size={25} />}
        title="Make room for your next idea"
        description="Your open and pending trades will live here. Start with a setup you believe in."
        action={emptyAction}
      />
    );
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Status</th>
            <th className="number">Entry / limit</th>
            <th className="number">Last price</th>
            <th className="number">P&L</th>
            <th className="number">Target / stop</th>
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
                      {t.qty} shares · {t.setupTag || 'No setup tag'}
                    </small>
                  </span>
                </button>
              </td>
              <td>
                <Status status={t.status} />
              </td>
              <td className="number">{money(t.entryPrice ?? t.limitPrice ?? t.quote?.ltp)}</td>
              <td className="number">
                {t.quote ? (
                  <>
                    {money(t.quote.ltp)}
                    <small>{datetime(t.quote.ts)}</small>
                  </>
                ) : (
                  <span className="muted">Unavailable</span>
                )}
              </td>
              <td className={`number ${pnlClass(t.unrealisedPnl)}`}>
                {t.unrealisedPnl != null ? signed(t.unrealisedPnl) : '—'}
              </td>
              <td className="number">
                <span>{money(t.targetPrice)}</span>
                <small>{money(t.stopPrice)}</small>
              </td>
              <td>
                <ChevronRight size={16} className="muted" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
