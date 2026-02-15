-- Migration: Webhook-Driven Credit System
-- Adds fields to support webhook-driven credit refresh instead of user-action-based refresh

-- Add auto_renew_status to subscriptions table
ALTER TABLE subscriptions 
ADD COLUMN IF NOT EXISTS auto_renew_status BOOLEAN DEFAULT true;

-- Add last_weekly_refresh_at to credit_balances table
ALTER TABLE credit_balances 
ADD COLUMN IF NOT EXISTS last_weekly_refresh_at TIMESTAMP WITH TIME ZONE;

-- Add index for safety net cron query performance
CREATE INDEX IF NOT EXISTS idx_credit_balances_refresh_check 
ON credit_balances(last_weekly_refresh_at) 
WHERE last_weekly_refresh_at IS NOT NULL;

-- Add index for subscription expiry checks
CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry 
ON subscriptions(expires_at, auto_renew_status) 
WHERE status = 'active';

-- Update existing users to set initial last_weekly_refresh_at
-- This prevents immediate refresh for existing users
UPDATE credit_balances 
SET last_weekly_refresh_at = NOW() 
WHERE last_weekly_refresh_at IS NULL 
AND weekly_remaining > 0;

COMMENT ON COLUMN subscriptions.auto_renew_status IS 'Whether subscription will auto-renew. Updated via Apple webhooks.';
COMMENT ON COLUMN credit_balances.last_weekly_refresh_at IS 'Timestamp of last weekly credit refresh. Used for webhook-driven refresh logic.';
