import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { resolve, dirname } from 'node:path';
import { mdxToMarkdown } from '../lib/mdxToMarkdown';

// Serve the Markdown source of every docs page at `/<slug>.md`, so readers and
// agents can fetch one page instead of the 1.3 MB `llms-full.txt`.
//
// The body is transformed rather than served raw: MDX component tags and the
// `?raw` example imports would otherwise reach the reader as literal markup
// with no code in it. `scripts/sync-package-guides.ts` runs the same transform
// for the copy shipped in `@kuralle-agents/core`, so both agree.

const CONTENT_ROOT = resolve(process.cwd(), 'src/content/docs');
const SITE = 'https://agents.kuralle.com';

export const getStaticPaths = (async () => {
  const docs = await getCollection('docs');
  return docs.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => {
  const entry = props.entry as Awaited<ReturnType<typeof getCollection<'docs'>>>[number];
  const title = typeof entry.data.title === 'string' ? entry.data.title : entry.id;
  const description =
    typeof entry.data.description === 'string' ? entry.data.description : undefined;

  const markdown = mdxToMarkdown({
    title,
    description,
    body: entry.body ?? '',
    baseDir: resolve(CONTENT_ROOT, dirname(entry.id)),
    site: SITE,
  });

  return new Response(markdown, {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
};
