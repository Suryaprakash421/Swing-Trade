-- Keep wall-clock creation separate from the delayed feed's causal market time.
ALTER TABLE trades ADD COLUMN requested_market_at timestamptz;

-- Prevent post-reset daily equity backfill from recreating prior-account history.
ALTER TABLE accounts ADD COLUMN reset_at timestamptz NOT NULL DEFAULT now();
UPDATE accounts SET reset_at=created_at;
