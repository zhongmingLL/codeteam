# @codeteam/skills

Curated skill catalog for codeteam. The manifest lists only routing metadata; the skill
`name`, `description`, and `triggers` come from each `SKILL.md` frontmatter.

```ts
import { loadCuratedCatalog } from "@codeteam/skills";

const catalog = loadCuratedCatalog({ catalogRoot });
const skillPaths = catalog.skillPaths; // pass to the adapter as curatedSkillPaths
```

The resolver rejects absolute paths, `..`, symlink escapes, missing `SKILL.md`, name mismatches,
and secret-shaped file content. Warnings cover dangling `next` references. An empty manifest is a
valid allowlist and loads nothing.
