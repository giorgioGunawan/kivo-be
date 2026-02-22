-- Migration 005: Security tables for transaction deduplication and webhook replay protection

-- Tracks processed Apple transaction IDs to prevent replay attacks on credit purchases
CREATE TABLE IF NOT EXISTS processed_transactions (
    id SERIAL PRIMARY KEY,
    transaction_id VARCHAR(255) UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id),
    product_id VARCHAR(255),
    credits_granted INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_transactions_tx_id ON processed_transactions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_processed_transactions_user_id ON processed_transactions(user_id);

-- Tracks processed webhook events to prevent replay attacks
CREATE TABLE IF NOT EXISTS webhook_events (
    id SERIAL PRIMARY KEY,
    event_hash VARCHAR(64) UNIQUE NOT NULL,
    source VARCHAR(50) NOT NULL,
    notification_type VARCHAR(100),
    user_id INTEGER REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_hash ON webhook_events(event_hash);
