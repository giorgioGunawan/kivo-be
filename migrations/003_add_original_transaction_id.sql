-- Add original_transaction_id to subscriptions table
ALTER TABLE subscriptions 
ADD COLUMN IF NOT EXISTS original_transaction_id VARCHAR(255);

-- Create index for webhook lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_original_transaction_id 
ON subscriptions(original_transaction_id);
