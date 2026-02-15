const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function runMigration() {
    console.log('🚀 Running Webhook-Driven Credit System Migration...\n');

    // Determine connection config
    const config = process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || 'password',
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || 5432,
            database: process.env.DB_NAME || 'kivo_ai',
        };

    const client = new Client(config);

    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        // Read migration file
        const migrationPath = path.join(__dirname, '../migrations/002_webhook_driven_credits.sql');
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');

        console.log('📝 Executing migration SQL...\n');
        await client.query(migrationSql);

        console.log('✅ Migration completed successfully!\n');
        console.log('Summary of changes:');
        console.log('  - Added auto_renew_status to subscriptions table');
        console.log('  - Added last_weekly_refresh_at to credit_balances table');
        console.log('  - Created indexes for performance');
        console.log('  - Updated existing users to prevent immediate refresh\n');

        // Verify changes
        console.log('🔍 Verifying schema changes...\n');

        const subscriptionColumns = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'subscriptions' 
            AND column_name IN ('auto_renew_status')
        `);

        const creditBalanceColumns = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'credit_balances' 
            AND column_name IN ('last_weekly_refresh_at')
        `);

        if (subscriptionColumns.rows.length > 0) {
            console.log('✅ subscriptions.auto_renew_status added');
        } else {
            console.warn('⚠️  subscriptions.auto_renew_status not found');
        }

        if (creditBalanceColumns.rows.length > 0) {
            console.log('✅ credit_balances.last_weekly_refresh_at added');
        } else {
            console.warn('⚠️  credit_balances.last_weekly_refresh_at not found');
        }

        console.log('\n✨ Migration complete! The webhook-driven credit system is now active.\n');

    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        console.error(err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

runMigration();
