import { describe, expect, it } from 'bun:test';
import { publishGitHubDraft, type FetchLike } from '../src/github.js';
import type { ReleaseCandidate } from '../src/types.js';

const candidate: ReleaseCandidate = {
  schemaVersion: 1,
  repository: 'acme/widgets',
  branch: 'main',
  headSha: 'a'.repeat(40),
  tagName: 'v1.2.3',
  title: 'Widgets 1.2.3',
  body: '## Added\n\n- Production release governance.',
  checkRunCompletedAt: '2026-07-30T00:00:00.000Z',
  createdAt: '2026-07-30T00:01:00.000Z',
  revision: 'b'.repeat(64),
};

function json(value: unknown, init: ResponseInit): Response {
  return new Response(JSON.stringify(value), { ...init, headers: { 'content-type': 'application/json' } });
}

describe('publishGitHubDraft', () => {
  it('creates only a draft release with the candidate commit and content', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) return json({ message: 'Not Found' }, { status: 404 });
      return json({ id: 42, html_url: 'https://github.com/acme/widgets/releases/tag/untagged-draft', tag_name: candidate.tagName, draft: true }, { status: 201 });
    }) as FetchLike;
    const result = await publishGitHubDraft(candidate, { token: 'secret', fetchImpl });
    expect(result).toEqual({ id: 42, htmlUrl: 'https://github.com/acme/widgets/releases/tag/untagged-draft', tagName: 'v1.2.3', draft: true, reused: false });
    const payload = JSON.parse(String(calls[1]?.init?.body));
    expect(payload).toMatchObject({ tag_name: 'v1.2.3', target_commitish: candidate.headSha, draft: true, prerelease: false, generate_release_notes: false });
  });

  it('reuses an exact existing draft and refuses a mismatch', async () => {
    const exact = { id: 7, html_url: 'https://example.test/draft', tag_name: candidate.tagName, target_commitish: candidate.headSha, name: candidate.title, body: candidate.body, draft: true };
    const reused = await publishGitHubDraft(candidate, { token: 'secret', fetchImpl: async () => json(exact, { status: 200 }) });
    expect(reused.reused).toBe(true);
    await expect(publishGitHubDraft(candidate, {
      token: 'secret',
      fetchImpl: async () => json({ ...exact, body: 'different' }, { status: 200 }),
    })).rejects.toThrow(/refusing to overwrite/);
  });
});
