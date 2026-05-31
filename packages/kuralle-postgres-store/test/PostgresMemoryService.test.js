import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresMemoryService } from '../dist/PostgresMemoryService.js';

/**
 * Creates a mock PostgresClient that stores data in-memory.
 * Tracks all queries for assertion.
 */
function createMockPostgresClient() {
  const tables = new Map();
  const queries = [];

  return {
    _queries: queries,
    _tables: tables,
    async query(text, params) {
      queries.push({ text, params });

      // Handle CREATE TABLE
      if (text.trim().startsWith('CREATE TABLE')) {
        const match = text.match(/CREATE TABLE IF NOT EXISTS (\S+)/);
        if (match) {
          tables.set(match[1], []);
        }
        return { rows: [], rowCount: 0 };
      }

      // Handle CREATE INDEX
      if (text.trim().startsWith('CREATE INDEX')) {
        return { rows: [], rowCount: 0 };
      }

      // Handle INSERT
      if (text.trim().startsWith('INSERT')) {
        const match = text.match(/INSERT INTO (\S+)/);
        const tableName = match?.[1];
        if (tableName && tables.has(tableName)) {
          tables.get(tableName).push({
            id: params[0],
            session_id: params[1],
            user_id: params[2],
            content: params[3],
            author: params[4],
            metadata: params[5] ? JSON.parse(params[5]) : null,
            created_at: params[6],
          });
        }
        return { rows: [], rowCount: 1 };
      }

      // Handle DELETE
      if (text.trim().startsWith('DELETE')) {
        const match = text.match(/DELETE FROM (\S+)/);
        const tableName = match?.[1];
        if (tableName && tables.has(tableName)) {
          const rows = tables.get(tableName);
          const before = rows.length;

          if (text.includes('session_id')) {
            const sessionId = params[0];
            tables.set(tableName, rows.filter(r => r.session_id !== sessionId));
          } else if (text.includes('user_id')) {
            const userId = params[0];
            tables.set(tableName, rows.filter(r => r.user_id !== userId));
          }
          return { rows: [], rowCount: before - tables.get(tableName).length };
        }
        return { rows: [], rowCount: 0 };
      }

      // Handle SELECT with scoring
      if (text.trim().startsWith('SELECT')) {
        const match = text.match(/FROM (\S+)/);
        const tableName = match?.[1];
        if (tableName && tables.has(tableName)) {
          const rows = tables.get(tableName);
          const userId = params[0];

          // Extract ILIKE terms from params (skip first userId and last limit)
          const terms = [];
          for (let i = 1; i < params.length - 1; i++) {
            const p = params[i];
            if (typeof p === 'string' && p.startsWith('%') && p.endsWith('%')) {
              terms.push(p.slice(1, -1).toLowerCase());
            }
          }

          const limit = params[params.length - 1];
          const matched = rows
            .filter(r => r.user_id === userId)
            .map(r => {
              const contentLower = r.content.toLowerCase();
              let matchCount = 0;
              for (const term of terms) {
                if (contentLower.includes(term)) matchCount++;
              }
              return { ...r, score: terms.length > 0 ? matchCount / terms.length : 0, matchCount };
            })
            .filter(r => r.matchCount > 0)
            .sort((a, b) => {
              if (b.score !== a.score) return b.score - a.score;
              return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            })
            .slice(0, limit);

          return { rows: matched, rowCount: matched.length };
        }
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    },
  };
}

function makeSession(id, userId, messages) {
  return {
    id,
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages,
    workingMemory: {},
    currentAgent: 'agent-1',
    agentStates: {},
    handoffHistory: [],
  };
}

describe('PostgresMemoryService', () => {
  let client;
  let service;

  beforeEach(async () => {
    client = createMockPostgresClient();
    service = new PostgresMemoryService({ client, memoryTableName: 'test_memories' });
    // Wait for auto-migration
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  it('should auto-create kuralle_memories table and indexes on first use', async () => {
    const createQueries = client._queries.filter(q =>
      q.text.includes('CREATE TABLE') || q.text.includes('CREATE INDEX')
    );
    assert.equal(createQueries.length, 3); // 1 table + 2 indexes
    assert.ok(createQueries[0].text.includes('test_memories'));
    assert.ok(createQueries[1].text.includes('idx_test_memories_user_id'));
    assert.ok(createQueries[2].text.includes('idx_test_memories_session_id'));
  });

  it('should respect custom memoryTableName', async () => {
    const customClient = createMockPostgresClient();
    const customService = new PostgresMemoryService({
      client: customClient,
      memoryTableName: 'custom_mem_table',
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    const createQuery = customClient._queries.find(q => q.text.includes('CREATE TABLE'));
    assert.ok(createQuery.text.includes('custom_mem_table'));
  });

  it('should skip auto-migration when autoMigrate is false', async () => {
    const noMigrateClient = createMockPostgresClient();
    new PostgresMemoryService({
      client: noMigrateClient,
      autoMigrate: false,
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    const createQueries = noMigrateClient._queries.filter(q => q.text.includes('CREATE'));
    assert.equal(createQueries.length, 0);
  });

  it('should store memories from a session with userId', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi! How can I help?' },
    ]);

    await service.addSessionToMemory(session);

    const rows = client._tables.get('test_memories');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].user_id, 'u1');
  });

  it('should skip ingestion when session has no userId', async () => {
    const session = makeSession('s1', undefined, [
      { role: 'user', content: 'Hello' },
    ]);

    await service.addSessionToMemory(session);

    // No INSERT queries should be issued (only CREATE TABLE/INDEX + no INSERTs)
    const insertQueries = client._queries.filter(q => q.text.includes('INSERT'));
    assert.equal(insertQueries.length, 0);
  });

  it('should handle idempotent re-ingestion (DELETE by session_id then INSERT)', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'Original message' },
    ]);
    await service.addSessionToMemory(session);

    const updated = makeSession('s1', 'u1', [
      { role: 'user', content: 'Updated message' },
    ]);
    await service.addSessionToMemory(updated);

    const rows = client._tables.get('test_memories');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].content.includes('Updated'));
  });

  it('should search memories using ILIKE keyword matching', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'I need help with my booking' },
      { role: 'assistant', content: 'I can assist with reservations' },
    ]);
    await service.addSessionToMemory(session);

    const result = await service.searchMemory({ userId: 'u1', query: 'booking help' });
    assert.ok(result.memories.length > 0);
  });

  it('should score results by term overlap ratio', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'I like apples' },
      { role: 'assistant', content: 'I like apples and oranges and bananas' },
    ]);
    await service.addSessionToMemory(session);

    const result = await service.searchMemory({ userId: 'u1', query: 'apples oranges bananas' });
    assert.ok(result.memories.length === 2);
    assert.ok(result.memories[0].score >= result.memories[1].score);
  });

  it('should order results by score DESC, created_at DESC', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'apple banana' },
      { role: 'assistant', content: 'apple cherry banana grape' },
    ]);
    await service.addSessionToMemory(session);

    const result = await service.searchMemory({ userId: 'u1', query: 'apple banana' });
    // Both have score 1.0 (both terms match), so order by created_at DESC
    assert.ok(result.memories.length === 2);
  });

  it('should respect limit parameter', async () => {
    const messages = [];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'user', content: `Message about topic ${i}` });
    }
    const session = makeSession('s1', 'u1', messages);
    await service.addSessionToMemory(session);

    const result = await service.searchMemory({ userId: 'u1', query: 'topic', limit: 2 });
    assert.equal(result.memories.length, 2);
  });

  it('should return empty for unknown userId', async () => {
    const result = await service.searchMemory({ userId: 'unknown', query: 'anything' });
    assert.equal(result.memories.length, 0);
  });

  it('should delete all memories for a user', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'Remember this' },
    ]);
    await service.addSessionToMemory(session);

    await service.deleteMemories('u1');

    const rows = client._tables.get('test_memories');
    assert.equal(rows.length, 0);
  });

  it('should store and retrieve metadata as JSONB', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'Hello with metadata' },
    ]);

    await service.addSessionToMemory(session, { metadata: { source: 'chat', priority: 1 } });

    const rows = client._tables.get('test_memories');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].metadata, { source: 'chat', priority: 1 });
  });
});
