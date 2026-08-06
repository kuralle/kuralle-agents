import { describe, expect, it } from 'bun:test';
import { packageAllSkills } from './helpers.js';

/**
 * b4 ported these skills off the removed vendor integrations (Notion, Vercel Blob, Typefully,
 * Resend) onto this app's own tools (content/asset tools, and the `social_posts`/`email_sends`
 * tables). A stray mention left behind reads as documentation for a dependency this app no
 * longer has, and would mislead whoever reads the skill next.
 */
const VENDOR_NAMES = ['Notion', 'Vercel Blob', 'Typefully', 'Resend'];

describe('no ported skill still names a removed vendor dependency', () => {
  it('checked more than a token number of skill bodies (the loop is real)', async () => {
    const skills = await packageAllSkills();
    expect(skills.length).toBeGreaterThan(0);
  });

  it.each(VENDOR_NAMES)('no skill file mentions "%s"', async (vendor) => {
    const skills = await packageAllSkills();
    for (const skill of skills) {
      for (const [path, file] of Object.entries(skill.files)) {
        const text = Buffer.from(file.content, 'base64').toString('utf8');
        expect(text.includes(vendor), `${skill.name}: ${path} still mentions "${vendor}"`).toBe(false);
      }
    }
  });
});
