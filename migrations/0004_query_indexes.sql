CREATE INDEX IF NOT EXISTS idx_transactions_date
ON transactions(date);

CREATE INDEX IF NOT EXISTS idx_transactions_method_date
ON transactions(method_id, date);

CREATE INDEX IF NOT EXISTS idx_transactions_recurring_date
ON transactions(recurring_id, date);

CREATE INDEX IF NOT EXISTS idx_budgets_period_category
ON budgets(period_start, category_id);

CREATE INDEX IF NOT EXISTS idx_recurring_next_date
ON recurring(enabled, next_date);
