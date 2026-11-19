CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  closed_at TEXT,
  payload_json TEXT NOT NULL,
  file_keys_json TEXT NOT NULL,
  file_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status_closed_at ON orders(status, closed_at);

CREATE TABLE IF NOT EXISTS storage_usage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  reserved_bytes INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO storage_usage (singleton, reserved_bytes) VALUES (1, 0);
