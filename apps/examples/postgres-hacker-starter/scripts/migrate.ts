import { getPool, migrateDatabase } from '../server/database';

await migrateDatabase();
console.info('Database migration complete.');
await getPool().end();
