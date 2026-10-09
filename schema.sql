CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payment_requests (
  id UUID PRIMARY KEY,
  customer_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('advertising_sponsorship', 'blue_badge')),
  amount_kz INTEGER NOT NULL CHECK (amount_kz > 0),
  payment_method TEXT NOT NULL DEFAULT 'multicaixa_express',
  payment_phone TEXT NOT NULL,
  transaction_reference TEXT,
  receipt_storage_name TEXT NOT NULL,
  receipt_original_name TEXT NOT NULL,
  receipt_mime_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note TEXT,
  reviewed_by BIGINT REFERENCES admin_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS payment_requests_status_created_idx
  ON payment_requests (status, created_at DESC);
