CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (username = lower(username) AND username ~ '^[a-z0-9_]{3,30}$'),
  password_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  starting_capital numeric(18,2) NOT NULL DEFAULT 100000 CHECK (starting_capital > 0),
  slippage_bps integer NOT NULL DEFAULT 5 CHECK (slippage_bps BETWEEN 0 AND 1000),
  limit_validity_days integer NOT NULL DEFAULT 5 CHECK (limit_validity_days BETWEEN 1 AND 365),
  reservation_buffer_bps integer NOT NULL DEFAULT 200 CHECK (reservation_buffer_bps BETWEEN 0 AND 10000),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE instruments (
  symbol text PRIMARY KEY,
  name text NOT NULL,
  yahoo_symbol text NOT NULL,
  tick_size numeric(12,4) NOT NULL DEFAULT 0.05 CHECK (tick_size > 0),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol text NOT NULL REFERENCES instruments(symbol),
  qty integer NOT NULL CHECK (qty > 0),
  entry_type text NOT NULL CHECK (entry_type IN ('MARKET','LIMIT')),
  limit_price numeric(18,4),
  target_price numeric(18,4) NOT NULL CHECK (target_price > 0),
  stop_price numeric(18,4) NOT NULL CHECK (stop_price > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','OPEN','CLOSED','CANCELLED','EXPIRED')),
  entry_price numeric(18,4),
  entry_at timestamptz,
  exit_price numeric(18,4),
  exit_at timestamptz,
  exit_reason text CHECK (exit_reason IN ('TARGET','STOP','MANUAL')),
  reserved_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  charges numeric(18,2) NOT NULL DEFAULT 0 CHECK (charges >= 0),
  gross_pnl numeric(18,2),
  net_pnl numeric(18,2),
  initial_risk numeric(18,2),
  slippage_bps integer CHECK (slippage_bps BETWEEN 0 AND 1000),
  setup_tag text NOT NULL DEFAULT '',
  thesis text NOT NULL DEFAULT '',
  review text NOT NULL DEFAULT '',
  rejection_reason text,
  inferred boolean NOT NULL DEFAULT false,
  gap_fill boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  last_checked_at timestamptz,
  last_candle_at timestamptz,
  recovery_paused boolean NOT NULL DEFAULT false,
  recovery_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text,
  generation integer NOT NULL DEFAULT 0,
  UNIQUE (account_id,id),
  UNIQUE (account_id,idempotency_key),
  CHECK (stop_price < target_price),
  CHECK ((entry_type='LIMIT' AND limit_price > 0) OR (entry_type='MARKET' AND limit_price IS NULL)),
  CHECK (entry_price IS NULL OR entry_price > 0),
  CHECK (exit_price IS NULL OR exit_price > 0),
  CHECK (status NOT IN ('OPEN','CLOSED') OR (entry_price IS NOT NULL AND entry_at IS NOT NULL)),
  CHECK (status <> 'CLOSED' OR (exit_price IS NOT NULL AND exit_at IS NOT NULL AND exit_reason IS NOT NULL AND gross_pnl IS NOT NULL AND net_pnl IS NOT NULL)),
  CHECK (status = 'PENDING' OR reserved_amount = 0)
);
CREATE INDEX trades_active_idx ON trades (symbol,status) WHERE status IN ('PENDING','OPEN');
CREATE INDEX trades_account_status_idx ON trades(account_id,status,created_at DESC);
CREATE INDEX trades_account_exit_idx ON trades(account_id,exit_at DESC) WHERE status='CLOSED';
CREATE TABLE trade_events (
  id bigserial PRIMARY KEY,
  trade_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type text NOT NULL,
  price numeric(18,4),
  payload jsonb NOT NULL DEFAULT '{}',
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id,trade_id) REFERENCES trades(account_id,id) ON DELETE CASCADE
);
CREATE INDEX trade_events_account_id_idx ON trade_events(account_id,id);
CREATE INDEX trade_events_trade_time_idx ON trade_events(trade_id,effective_at,id);
CREATE TABLE latest_quotes (
  symbol text PRIMARY KEY REFERENCES instruments(symbol),
  ltp numeric(18,4) NOT NULL CHECK (ltp > 0),
  market_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  delayed boolean NOT NULL DEFAULT true
);
CREATE TABLE quote_requests (
  symbol text PRIMARY KEY REFERENCES instruments(symbol) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX quote_requests_expiry_idx ON quote_requests(expires_at);
CREATE TABLE price_bars_1m (
  symbol text NOT NULL REFERENCES instruments(symbol),
  ts timestamptz NOT NULL,
  open numeric(18,4) NOT NULL CHECK (open > 0),
  high numeric(18,4) NOT NULL CHECK (high > 0),
  low numeric(18,4) NOT NULL CHECK (low > 0),
  close numeric(18,4) NOT NULL CHECK (close > 0),
  provider text NOT NULL,
  PRIMARY KEY (symbol,ts),
  CHECK (high >= low AND high >= open AND high >= close AND low <= open AND low <= close)
);
CREATE TABLE market_sessions (
  date date PRIMARY KEY,
  is_open boolean NOT NULL,
  open_time text NOT NULL DEFAULT '09:15' CHECK (open_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  close_time text NOT NULL DEFAULT '15:30' CHECK (close_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  description text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual'
);
CREATE TABLE equity_snapshots (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date date NOT NULL,
  equity numeric(18,2) NOT NULL,
  stale boolean NOT NULL DEFAULT false,
  PRIMARY KEY (account_id,date)
);
CREATE TABLE engine_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id=1),
  heartbeat_at timestamptz,
  status text NOT NULL DEFAULT 'STARTING',
  message text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT 'yahoo'
);
INSERT INTO engine_state(id,status,message) VALUES (1,'STARTING','Engine has not started yet');
CREATE TABLE notification_preferences (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  telegram_chat_id text,
  verified boolean NOT NULL DEFAULT false,
  CHECK (NOT enabled OR (telegram_chat_id IS NOT NULL AND verified))
);
CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  trade_id uuid,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  FOREIGN KEY (account_id,trade_id) REFERENCES trades(account_id,id) ON DELETE CASCADE,
  CHECK (trade_id IS NULL OR account_id IS NOT NULL)
);
CREATE INDEX outbox_pending_idx ON outbox(next_attempt_at) WHERE delivered_at IS NULL;
CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 0 CHECK (count>=0),
  reset_at timestamptz NOT NULL
);
