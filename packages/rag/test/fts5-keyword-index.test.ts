import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { BM25Index } from '../src/search/BM25Index.js';
import { Fts5KeywordIndex } from '../src/search/Fts5KeywordIndex.js';
import { KnowledgeFs } from '../src/fs/KnowledgeFs.js';
import type { SqlExecutor } from '../src/sql.js';
import { KB_INDEX, seedKnowledgeStore } from './knowledgefs-fixture.js';

function bunSqlExecutor(db: Database): SqlExecutor {
  return (<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const query = strings.reduce(
      (acc, part, i) => acc + part + (i < values.length ? '?' : ''),
      '',
    );
    return db.query(query).all(...(values as never[])) as T[];
  }) as SqlExecutor;
}

const CORPUS = [
  { id: 'a#0', text: 'Our refund policy allows returns within 30 days of delivery.' },
  { id: 'b#0', text: 'Shipping is free for orders above fifty dollars.' },
  { id: 'c#0', text: 'The warranty covers manufacturing defects for two years.' },
  { id: 'd#0', text: 'Refunds are processed to the original payment method.' },
  { id: 'e#0', text: 'Express delivery arrives in two business days.' },
];

describe('test:fts5 KeywordIndex contract', () => {
  it('matches BM25Index top results on the same corpus', () => {
    const bm25 = new BM25Index();
    bm25.add(CORPUS);
    const fts5 = new Fts5KeywordIndex({ sql: bunSqlExecutor(new Database(':memory:')) });
    fts5.add(CORPUS);

    for (const query of ['refund policy', 'shipping delivery', 'warranty defects']) {
      const expected = bm25.search(query, 3).map((r) => r.id);
      const actual = fts5.search(query, 3).map((r) => r.id);
      expect(actual[0]).toBe(expected[0]!);
      // top-3 set parity (scores differ slightly; the set should not)
      expect(new Set(actual)).toEqual(new Set(expected));
    }
  });

  it('supports overwrite, remove, clear, and size like BM25Index', () => {
    const fts5 = new Fts5KeywordIndex({ sql: bunSqlExecutor(new Database(':memory:')) });
    fts5.add(CORPUS);
    expect(fts5.size).toBe(5);

    fts5.add([{ id: 'a#0', text: 'completely different content now' }]);
    expect(fts5.size).toBe(5); // overwrite, not append
    expect(fts5.search('refund', 5).map((r) => r.id)).not.toContain('a#0');

    expect(fts5.remove('b#0')).toBe(true);
    expect(fts5.remove('b#0')).toBe(false);
    expect(fts5.size).toBe(4);

    fts5.clear();
    expect(fts5.size).toBe(0);
    expect(fts5.search('refund')).toEqual([]);
  });

  it('returns [] for stop-word-only and empty queries', () => {
    const fts5 = new Fts5KeywordIndex({ sql: bunSqlExecutor(new Database(':memory:')) });
    fts5.add(CORPUS);
    expect(fts5.search('the and of')).toEqual([]);
    expect(fts5.search('')).toEqual([]);
  });

  it('is safe against FTS5 query syntax in user input', () => {
    const fts5 = new Fts5KeywordIndex({ sql: bunSqlExecutor(new Database(':memory:')) });
    fts5.add(CORPUS);
    // None of these may throw — they must be treated as plain terms.
    expect(() => fts5.search('refund AND policy"')).not.toThrow();
    expect(() => fts5.search('NEAR(refund, 2) OR *')).not.toThrow();
    expect(() => fts5.search('col:refund -policy')).not.toThrow();
  });

  it('matches space-delimited non-Latin scripts with the default tokenizer', () => {
    const fts5 = new Fts5KeywordIndex({ sql: bunSqlExecutor(new Database(':memory:')) });
    fts5.add([
      { id: 'ta', text: 'பணத்தைத் திரும்பப் பெறுதல் கொள்கை முப்பது நாட்கள்' }, // Tamil: refund policy
      { id: 'si', text: 'මුදල් ආපසු ගෙවීමේ ප්‍රතිපත්තිය දින තිහක්' }, // Sinhala: refund policy
      { id: 'de', text: 'Rückerstattungsrichtlinie innerhalb von dreißig Tagen' },
    ]);
    expect(fts5.search('கொள்கை', 2)[0]?.id).toBe('ta');
    expect(fts5.search('ප්‍රතිපත්තිය', 2)[0]?.id).toBe('si');
    expect(fts5.search('Rückerstattungsrichtlinie', 2)[0]?.id).toBe('de');

    // BM25Index shares the tokenizer — Indic scripts must work there too.
    const bm25 = new BM25Index();
    bm25.add([{ id: 'ta', text: 'பணத்தைத் திரும்பப் பெறுதல் கொள்கை முப்பது நாட்கள்' }]);
    expect(bm25.search('கொள்கை', 1)[0]?.id).toBe('ta');
  });

  it('matches unsegmented languages (CJK) with the trigram tokenizer', () => {
    const fts5 = new Fts5KeywordIndex({
      sql: bunSqlExecutor(new Database(':memory:')),
      tokenize: 'trigram',
    });
    fts5.add([
      { id: 'ja', text: '返金ポリシーは配達後30日以内です' }, // Japanese: refund policy
      { id: 'zh', text: '退款政策为送达后三十天内' }, // Chinese: refund policy
    ]);
    expect(fts5.search('ポリシー', 2)[0]?.id).toBe('ja');
    expect(fts5.search('退款政策', 2)[0]?.id).toBe('zh');
  });

  it('rejects an unsafe tokenize spec', () => {
    expect(
      () =>
        new Fts5KeywordIndex({
          sql: bunSqlExecutor(new Database(':memory:')),
          tokenize: "trigram'); DROP TABLE x; --",
        }),
    ).toThrow(/Invalid FTS5 tokenize spec/);
  });

  it('persists: a new instance over the same database needs zero re-seeding', () => {
    const db = new Database(':memory:');
    const first = new Fts5KeywordIndex({ sql: bunSqlExecutor(db) });
    first.add(CORPUS);

    // "Wake": fresh instance, same storage — data already there.
    const woken = new Fts5KeywordIndex({ sql: bunSqlExecutor(db) });
    expect(woken.size).toBe(5);
    expect(woken.search('refund policy', 1)[0]?.id).toBe('a#0');
  });
});

describe('test:fts5 KnowledgeFs integration', () => {
  const PAGES = [
    { path: '/kb/refunds.md', chunks: ['Refund policy: 30 days, original payment method.'] },
    { path: '/kb/shipping.md', chunks: ['Shipping is free above fifty dollars.'] },
    { path: '/kb/warranty.md', chunks: ['Warranty covers defects for two years.'] },
  ];

  it('seeds an empty keyword index on open, then skips seeding a populated one', async () => {
    const store = await seedKnowledgeStore(PAGES);
    const db = new Database(':memory:');

    const fts5 = new Fts5KeywordIndex({ sql: bunSqlExecutor(db) });
    await KnowledgeFs.open({ store, indexName: KB_INDEX, keywordIndex: fts5 });
    expect(fts5.size).toBe(3); // seeded

    // Simulate hibernation wake: new index handle over the same storage.
    const woken = new Fts5KeywordIndex({ sql: bunSqlExecutor(db) });
    const sizeBefore = woken.size;
    const fs2 = await KnowledgeFs.open({ store, indexName: KB_INDEX, keywordIndex: woken });
    expect(woken.size).toBe(sizeBefore); // NOT re-seeded

    const hits = await fs2.search('refund policy', { limit: 2 });
    expect(hits[0]?.slug).toBe('/kb/refunds.md');
  });

  it('returns search hits in rank order, not corpus order', async () => {
    // '/kb/zz-target.md' sorts last in corpus order but must rank first.
    const store = await seedKnowledgeStore([
      { path: '/kb/aa-noise.md', chunks: ['The catalog mentions refund once: refund.'] },
      { path: '/kb/bb-noise.md', chunks: ['General shipping information page.'] },
      {
        path: '/kb/zz-target.md',
        chunks: ['Refund refund refund: the dedicated refund policy refund page.'],
      },
    ]);
    const fs = await KnowledgeFs.open({
      store,
      indexName: KB_INDEX,
      keywordIndex: new BM25Index(),
    });
    const hits = await fs.search('refund', { limit: 1 });
    expect(hits[0]?.slug).toBe('/kb/zz-target.md');
  });
});
