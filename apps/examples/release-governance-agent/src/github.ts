import type { PublishedDraftRelease, ReleaseCandidate } from './types.js';

interface GitHubReleaseResponse {
  id?: number;
  html_url?: string;
  tag_name?: string;
  target_commitish?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  message?: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function responseBody(response: Response): Promise<GitHubReleaseResponse> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as GitHubReleaseResponse; }
  catch { return { message: text.slice(0, 500) }; }
}

function result(value: GitHubReleaseResponse, reused: boolean): PublishedDraftRelease {
  if (!value.id || !value.html_url || !value.tag_name || value.draft !== true) {
    throw new Error('GitHub returned an incomplete or non-draft release response.');
  }
  return { id: value.id, htmlUrl: value.html_url, tagName: value.tag_name, draft: true, reused };
}

export async function publishGitHubDraft(
  candidate: ReleaseCandidate,
  options: { token: string; fetchImpl?: FetchLike },
): Promise<PublishedDraftRelease> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `https://api.github.com/repos/${candidate.repository}/releases`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${options.token}`,
    'content-type': 'application/json',
    'user-agent': 'kuralle-release-governance-agent',
    'x-github-api-version': '2022-11-28',
  };
  const existingResponse = await fetchImpl(`${base}/tags/${encodeURIComponent(candidate.tagName)}`, { headers });
  if (existingResponse.ok) {
    const existing = await responseBody(existingResponse);
    const exact = existing.draft === true
      && existing.tag_name === candidate.tagName
      && existing.target_commitish === candidate.headSha
      && existing.name === candidate.title
      && existing.body === candidate.body;
    if (!exact) throw new Error(`GitHub already has a different release for ${candidate.tagName}; refusing to overwrite it.`);
    return result(existing, true);
  }
  if (existingResponse.status !== 404) {
    const error = await responseBody(existingResponse);
    throw new Error(`GitHub release lookup failed (${existingResponse.status}): ${error.message ?? 'unknown error'}`);
  }
  const createdResponse = await fetchImpl(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tag_name: candidate.tagName,
      target_commitish: candidate.headSha,
      name: candidate.title,
      body: candidate.body,
      draft: true,
      prerelease: candidate.tagName.includes('-'),
      generate_release_notes: false,
    }),
  });
  const created = await responseBody(createdResponse);
  if (!createdResponse.ok) {
    throw new Error(`GitHub draft creation failed (${createdResponse.status}): ${created.message ?? 'unknown error'}`);
  }
  return result(created, false);
}
