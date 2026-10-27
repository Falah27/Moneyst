ALTER TABLE transactions ADD COLUMN recurring_id TEXT;

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  category_id TEXT NOT NULL,
  amount REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  category_id TEXT NOT NULL,
  method_id TEXT NOT NULL,
  amount REAL NOT NULL,
  day_of_month INTEGER NOT NULL,
  next_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
