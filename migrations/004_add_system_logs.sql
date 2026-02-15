CREATE TABLE IF NOT EXISTS system_logs (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL, -- e.g. 'cron_subscription_cleanup', 'apple_webhook', 'job_failure'
    level VARCHAR(20) DEFAULT 'info', -- 'info', 'warn', 'error'
    message TEXT,
    details JSONB, -- Store structured data like userId, oldStatus, newStatus
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast retrieval of latest logs
CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_event_type ON system_logs(event_type);
