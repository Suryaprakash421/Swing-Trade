import Decimal from 'decimal.js';

interface EstimateInput {
  entryType: 'MARKET' | 'LIMIT';
  quantityMode: 'qty' | 'amount';
  quantity: string;
  quote: string | undefined;
  limit: string;
  target: string;
  stop: string;
  tickSize: string;
  slippageBps: number;
  reservationBufferBps: number;
  availableCash: string;
}

function positive(value: string | undefined) {
  try {
    const parsed = new Decimal(value || 0);
    return parsed.isFinite() && parsed.gte(0) ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/** Mirrors server entry, whole-share sizing and reservation rounding. Display estimates only. */
export function estimateTrade(input: EstimateInput) {
  const tick = positive(input.tickSize).gt(0) ? positive(input.tickSize) : new Decimal('.05');
  const entry =
    input.entryType === 'LIMIT'
      ? positive(input.limit)
      : positive(input.quote)
          .times(new Decimal(1).plus(new Decimal(input.slippageBps).div(10000)))
          .div(tick)
          .ceil()
          .times(tick);
  const quantity = positive(input.quantity);
  const shares =
    input.quantityMode === 'qty'
      ? quantity.floor()
      : entry.gt(0)
        ? quantity.div(entry).floor()
        : new Decimal(0);
  const qty = shares.lte(Number.MAX_SAFE_INTEGER) ? shares.toNumber() : 0;
  const stop = positive(input.stop);
  const target = positive(input.target);
  const riskPerShare = Decimal.max(entry.minus(stop), 0);
  const rewardPerShare = Decimal.max(target.minus(entry), 0);
  const risk = riskPerShare.times(qty);
  const reward = rewardPerShare.times(qty);
  const estimated = entry.times(qty);
  const reservation = estimated
    .times(
      input.entryType === 'MARKET'
        ? new Decimal(1).plus(new Decimal(input.reservationBufferBps).div(10000))
        : 1,
    )
    .toDecimalPlaces(2, Decimal.ROUND_UP);
  return {
    entry: entry.toFixed(2),
    hasEntry: entry.gt(0),
    qty,
    risk: risk.toFixed(2),
    reward: reward.toFixed(2),
    estimated: estimated.toFixed(2),
    reserve: reservation.toFixed(2),
    insufficientCash: reservation.gt(positive(input.availableCash)),
    validBracket: entry.gt(0) && stop.gt(0) && stop.lt(entry) && target.gt(entry),
    riskPercent:
      entry.gt(0) && stop.gt(0) ? entry.minus(stop).div(entry).times(100).toFixed(1) : null,
    rewardPercent:
      entry.gt(0) && target.gt(0) ? target.minus(entry).div(entry).times(100).toFixed(1) : null,
    ratio: risk.gt(0) && reward.gt(0) ? reward.div(risk).toFixed(2) : null,
  };
}
