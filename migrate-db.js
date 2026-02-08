const db = require('./src/config/db');

async function migrate() {
    console.log('Running migration: Increasing idempotency_keys column sizes...');
    try {
        await db.query('ALTER TABLE idempotency_keys ALTER COLUMN request_hash TYPE TEXT;');
        await db.query('ALTER TABLE idempotency_keys ALTER COLUMN endpoint TYPE TEXT;');
        console.log('✅ Migration successful!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    }
}

migrate();
