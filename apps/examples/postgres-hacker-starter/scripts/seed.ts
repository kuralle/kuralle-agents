import { KNOWLEDGE_DOCUMENTS, DEMO_ORDERS } from '../server/data';
import { createEmbeddingFunction, getPool, migrateDatabase } from '../server/database';

const pool = getPool();
await migrateDatabase(pool);
const embedText = createEmbeddingFunction();

for (const document of KNOWLEDGE_DOCUMENTS) {
  const embedding = await embedText(`${document.title}: ${document.content}`);
  await pool.query(`
    INSERT INTO knowledge (id, title, content, category, embedding)
    VALUES ($1, $2, $3, $4, $5::vector)
    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content,
      category = EXCLUDED.category, embedding = EXCLUDED.embedding, updated_at = NOW()
  `, [document.id, document.title, document.content, document.category, `[${embedding.join(',')}]`]);
}

for (const order of DEMO_ORDERS) {
  await pool.query(`
    INSERT INTO orders (order_id, items, total, status) VALUES ($1, $2, $3, $4)
    ON CONFLICT (order_id) DO UPDATE SET items = EXCLUDED.items, total = EXCLUDED.total, status = EXCLUDED.status
  `, [order.orderId, [...order.items], order.total, order.status]);
}

console.info(`Seeded ${KNOWLEDGE_DOCUMENTS.length} knowledge documents and ${DEMO_ORDERS.length} orders.`);
await pool.end();
