---
"@kuralle-agents/fs": major
---

**Breaking:** `fsSkillStore` now accepts an ordered root array instead of `{ root }`. Later roots override earlier skills with the same frontmatter name, including their body and resources.
