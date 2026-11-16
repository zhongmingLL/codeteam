# @superagentteam/skills

Curated skill catalog for SuperAgentTeam. The manifest lists only routing metadata; the skill
`name`, `description`, and `triggers` come from each `SKILL.md` frontmatter.

```ts
import { loadCuratedCatalog } from "@superagentteam/skills";

const catalog = loadCuratedCatalog({ catalogRoot });
const skillPaths = catalog.skillPaths; // pass to the adapter as curatedSkillPaths
```

The resolver rejects absolute paths, `..`, symlink escapes, missing `SKILL.md`, name mismatches,
and secret-shaped file content. Warnings cover dangling `next` references. An empty manifest is a
valid allowlist and loads nothing.
