---
name: release-notes-style
description: Use when drafting or editing release notes or a changelog entry from local shipped-work source material.
license: Apache-2.0
---

# Release notes style

- Lead with what changed for the user, not an internal feature name.
- Describe fixes from the symptom the user saw.
- State breaking changes first with the required migration action.
- Group by Breaking changes, New, Improved, and Fixed; omit empty groups.
- Use present tense, plain language, and one or two sentences per entry.
- Date releases as `YYYY-MM-DD` and order newest first.

Read `references/format.md` and run `lint_against_style` before proposing the entry.
