-- Persistent brute-force tracking.
-- Replaces the in-memory Map() in src/routes/auth.js, which lost all
-- lockout state on every process restart (Render restarts on every deploy).

CREATE TABLE IF NOT EXISTS login_attempts (
  attempt_id    SERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  ip_address    VARCHAR(64)  NOT NULL,
  attempted_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Fast lookup for "how many recent failed attempts for this email+ip"
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_ip_time
  ON login_attempts (email, ip_address, attempted_at DESC);

-- Housekeeping: nothing older than a lockout window is ever queried again,
-- so this keeps the table from growing unbounded. Safe to run periodically
-- (e.g. from the existing hourly SLA sweep cron, or its own cron).
-- DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '1 day';