---
"@kuralle-agents/core": minor
"@kuralle-agents/build": minor
---

Rebuild the skill system around progressive disclosure that survives a real prompt cache.

`SKILL.md` front matter is parsed with a real YAML parser under the failsafe schema, so
`version: 1.0` stays the string it was written as instead of becoming `1`, and a malformed skill
fails loudly with the file named rather than being silently skipped. `load_skill` returns a framed
briefing that lists each bundled resource next to the exact `read_skill_resource` call that fetches
it, so a model no longer has to guess that resources exist or how to reach them.

A skill's `allowed-tools` is enforced at the tool boundary through `Policy`, not by asking the model
to remember it — though only once `load_skill` has succeeded for that skill, which makes it a
guard-rail for an honest model rather than an adversarial boundary. Only skills that actually
declare a list contribute to the permitted set, so adding an unrestricted skill never silently
narrows what another one allowed.

Skills can now be packaged into the build with `packageSkillsDirectory` from
`@kuralle-agents/build`. Packaged skills are workerd-clean — no `node:` builtins, no filesystem —
so the same skill set runs on Cloudflare Workers and Node without a second code path. Packaging
refuses to bundle secrets, and skill ids are content-addressed over length-prefixed (path, content)
pairs so two skills cannot collide on name alone.

The prompt catalog is frozen at a per-run baseline and changes are announced in-transcript rather
than by rewriting the system prompt, so a skill appearing mid-conversation no longer invalidates the
cache for every turn that follows; the baseline is rebuilt only at compaction. `ctx.getSkill(name)`
exposes a read-only handle for reading a skill's own bundled files, and a per-tenant `SkillResolver`
lets one deployment serve different skill sets to different tenants.

**Breaking:** filesystem skill discovery now defaults to `/.agents/skills` rather than `/skills`.
Pass an explicit root to `fsSkillStore` to keep the old location.

**Security:** caller-supplied `formData` can no longer overwrite framework run state. A request
carrying `formData: { resolvedSkills: … }` used to replace the per-tenant skill snapshot wholesale,
so the resolver never ran and attacker-chosen skill names and bodies reached the model in place of
the tenant's real ones. Framework state now lives under one reserved key and that key is stripped
from incoming form data.
