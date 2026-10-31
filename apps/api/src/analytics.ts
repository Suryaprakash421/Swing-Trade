import type { FastifyInstance } from 'fastify';
import { sql } from '@paper/db';
import { auth } from './auth.js';
import {
  D,
  Decimal,
  accountBalance,
  dateStart,
  istDate,
  money,
  tradeObject,
  type Row,
} from './domain.js';
import { filters, selectTrades } from './trading.js';

const sum = (items: Row[], field: string) =>
  items.reduce<Decimal>((total, item) => total.plus(item[field] ?? 0), D(0));
function maxDrawdown(values: string[]) {
  let peak = D(0),
    drawdown = D(0);
  for (const value of values) {
    const point = D(value);
    if (point.gt(peak)) peak = point;
    if (peak.gt(0)) drawdown = Decimal.max(drawdown, peak.minus(point).div(peak).times(100));
  }
  return Number(drawdown.toFixed(4));
}

export async function registerAnalytics(app: FastifyInstance) {
  app.get('/api/stats/equity-curve', async (request) => {
    const accountId = auth(request).accountId;
    const balance = await accountBalance(accountId);
    const rows =
      await sql`select date::text as date,equity,stale from equity_snapshots where account_id=${accountId} order by date`;
    const points: { date: string; equity: string; stale: boolean }[] = rows.map((r) => ({
      date: r.date,
      equity: money(r.equity),
      stale: r.stale,
    }));
    const firstDate = istDate(new Date(balance.account.reset_at ?? balance.account.created_at));
    // Initial capital anchors the curve; today's value is a live mark, not a fabricated historical close.
    if (!points.length || points[0]!.date > firstDate)
      points.unshift({
        date: firstDate,
        equity: money(balance.account.starting_capital),
        stale: false,
      });
    const today = istDate();
    if (!points.length || points[points.length - 1]!.date !== today)
      points.push({ date: today, equity: money(balance.equity), stale: balance.hasStaleMarks });
    else
      points[points.length - 1] = {
        date: today,
        equity: money(balance.equity),
        stale: balance.hasStaleMarks,
      };
    return { points, initialCapital: money(balance.account.starting_capital), liveDate: today };
  });

  app.get('/api/stats', async (request) => {
    const accountId = auth(request).accountId;
    const query = filters(request.query);
    const rows = await selectTrades(accountId, { ...query, status: 'CLOSED' });
    const wins = rows.filter((t) => D(t.net_pnl).gt(0)),
      losses = rows.filter((t) => D(t.net_pnl).lt(0));
    const profit = sum(wins, 'net_pnl'),
      loss = sum(losses, 'net_pnl').abs(),
      net = sum(rows, 'net_pnl');
    const rTrades = rows.filter((t) => D(t.initial_risk).gt(0));
    const averageR = rTrades.length
      ? rTrades
          .reduce<Decimal>((r, t) => r.plus(D(t.net_pnl).div(t.initial_risk)), D(0))
          .div(rTrades.length)
          .toNumber()
      : null;
    const averageHoldingDays = rows.length
      ? rows.reduce(
          (days, t) =>
            days + (new Date(t.exit_at).getTime() - new Date(t.entry_at).getTime()) / 86_400_000,
          0,
        ) / rows.length
      : 0;
    const sorted = [...rows].sort((a, b) => D(b.net_pnl).cmp(a.net_pnl));
    const [account] = await sql`select starting_capital from accounts where id=${accountId}`;
    const snapshots =
      await sql`select date::text as date,equity from equity_snapshots where account_id=${accountId}
      and (${query.from ?? null}::date is null or date >= ${query.from ?? null}::date)
      and (${query.to ?? null}::date is null or date <= ${query.to ?? null}::date) order by date`;
    // Account drawdown uses durable daily equity. Tag/date-filtered drawdown uses the selected closed-trade P&L curve and is explicitly identified.
    let drawdownValues = [
      String(account.starting_capital),
      ...snapshots.map((s) => String(s.equity)),
    ];
    let drawdownBasis = 'DAILY_EQUITY';
    if (query.tag || query.from || query.to) {
      let equity = D(account.starting_capital);
      drawdownValues = [
        String(equity),
        ...[...rows]
          .sort((a, b) => new Date(a.exit_at).getTime() - new Date(b.exit_at).getTime())
          .map((t) => {
            equity = equity.plus(t.net_pnl);
            return String(equity);
          }),
      ];
      drawdownBasis = 'FILTERED_CLOSED_TRADES';
    }
    const tags = new Map<string, Row[]>();
    for (const t of rows) {
      const tag = t.setup_tag || 'Untagged';
      tags.set(tag, [...(tags.get(tag) ?? []), t]);
    }
    return {
      totalTrades: rows.length,
      wins: wins.length,
      losses: losses.length,
      breakEven: rows.length - wins.length - losses.length,
      winRate: rows.length ? (wins.length / rows.length) * 100 : 0,
      averageWin: money(wins.length ? profit.div(wins.length) : 0),
      averageLoss: money(losses.length ? loss.div(losses.length) : 0),
      expectancy: money(rows.length ? net.div(rows.length) : 0),
      profitFactor: loss.gt(0) ? profit.div(loss).toNumber() : null,
      averageR,
      averageHoldingDays,
      maxDrawdown: maxDrawdown(drawdownValues),
      drawdownBasis,
      netPnl: money(net),
      bestTrade: sorted.length ? tradeObject(sorted[0]!) : null,
      worstTrade: sorted.length ? tradeObject(sorted[sorted.length - 1]!) : null,
      byTag: [...tags].map(([tag, trades]) => ({
        tag,
        totalTrades: trades.length,
        winRate: (trades.filter((t) => D(t.net_pnl).gt(0)).length / trades.length) * 100,
        netPnl: money(sum(trades, 'net_pnl')),
        expectancy: money(sum(trades, 'net_pnl').div(trades.length)),
      })),
    };
  });
}
