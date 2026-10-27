CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  item TEXT NOT NULL,
  category_id TEXT,
  method_id TEXT,
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  is_salary INTEGER NOT NULL DEFAULT 0,
  is_transfer INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS methods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_items (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  name TEXT NOT NULL,
  estimate REAL,
  done INTEGER NOT NULL DEFAULT 0,
  transaction_id TEXT,
  sort_order INTEGER,
  updated_at INTEGER NOT NULL
);
