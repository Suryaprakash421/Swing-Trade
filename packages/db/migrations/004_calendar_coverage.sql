-- An empty overrides table does not establish that every weekday is a session.
-- Only a reviewed complete annual NSE calendar import may establish coverage.
CREATE TABLE market_calendar_years (
  year integer PRIMARY KEY CHECK (year BETWEEN 2020 AND 2100),
  source text NOT NULL CHECK (length(source) > 0),
  verified_at timestamptz NOT NULL DEFAULT now()
);
