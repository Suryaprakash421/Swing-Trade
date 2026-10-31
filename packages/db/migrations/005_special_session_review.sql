-- Known special sessions whose official timings are not yet verified must remain gated.
ALTER TABLE market_sessions ADD COLUMN review_required boolean NOT NULL DEFAULT false;
