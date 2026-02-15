-- Database Schema for Kivo AI
-- Based on Specification v1.0

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    apple_user_id VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    product_id VARCHAR(255),
    status VARCHAR(50) NOT NULL, -- active, expired, revoked
    expires_at TIMESTAMP WITH TIME ZONE,
    auto_renew_status BOOLEAN DEFAULT true,
    last_verified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_ledger (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    pool_type VARCHAR(20) NOT NULL CHECK (pool_type IN ('weekly', 'purchased')),
    delta INTEGER NOT NULL,
    reason VARCHAR(50) NOT NULL CHECK (reason IN ('refresh', 'generation', 'purchase', 'expiry', 'refund_failure', 'refund_timeout', 'provider_error', 'admin_adjust')),
    job_id INTEGER, -- nullable for non-job related entries
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_balances (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    weekly_remaining INTEGER DEFAULT 0,
    purchased_remaining INTEGER DEFAULT 0,
    last_weekly_refresh_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS jobs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    provider VARCHAR(50),
    provider_job_id VARCHAR(255),
    provider_attempt INTEGER DEFAULT 0,
    parent_job_id INTEGER REFERENCES jobs(id),
    template_id VARCHAR(255),
    media_type VARCHAR(20) CHECK (media_type IN ('image', 'video')),
    status VARCHAR(20) CHECK (status IN ('created', 'queued', 'processing', 'completed', 'failed')),
    estimated_cost INTEGER,
    actual_cost INTEGER,
    result_url TEXT,
    job_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(255) PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    endpoint TEXT,
    request_hash TEXT,
    job_id INTEGER REFERENCES jobs(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS admin_config (
    key VARCHAR(255) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by VARCHAR(255)
);

CREATE TABLE IF NOT EXISTS external_events (
    id SERIAL PRIMARY KEY,
    source VARCHAR(50) CHECK (source IN ('apple', 'provider')),
    payload JSONB,
    verified BOOLEAN DEFAULT FALSE,
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_id ON credit_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
