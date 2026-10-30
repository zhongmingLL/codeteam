import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.cwd();
const failures = [];

const featureDir = join(root, "docs", "features");
const plansDir = join(root, "docs", "plans");
const backlogPath = join(root, "BACKLOG.md");
const docsReadmePath = join(root, "docs", "README.md");
const featureFilePattern = /^(F\d{3}[a-z]*)-[^/]+\.md$/;
const topLevelFeaturePattern = /^F\d{3}$/;
const backlogRowPattern = /^\|\s*(F\d{3})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/;

function read(path, label) {
	if (!existsSync(path)) {
		failures.push(`${label}: missing file ${path}`);
		return "";
	}
	return readFileSync(path, "utf8");
}

function markdownLinks(text, baseDir) {
	const links = [];
	for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
		const target = match[1].trim();
		if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
		links.push({ raw: target, resolved: resolve(baseDir, target.split("#")[0]) });
	}
	return links;
}

function frontmatter(text) {
	const match = text.match(/^---\n([\s\S]*?)\n---/);
	return match ? match[1] : "";
}

const featureDocs = readdirSync(featureDir)
	.filter((file) => file !== "TEMPLATE.md" && featureFilePattern.test(file))
	.map((file) => {
		const id = file.match(featureFilePattern)[1];
		return {
			id,
			file,
			path: join(featureDir, file),
			topLevel: topLevelFeaturePattern.test(id),
		};
	})
	.sort((left, right) => left.file.localeCompare(right.file));

const featureById = new Map();
for (const doc of featureDocs) {
	if (featureById.has(doc.id)) {
		failures.push(`docs/features: duplicate feature id ${doc.id} in ${featureById.get(doc.id).file} and ${doc.file}`);
		continue;
	}
	featureById.set(doc.id, doc);
}

const backlogRows = [];
for (const line of read(backlogPath, "BACKLOG.md").split("\n")) {
	const match = line.match(backlogRowPattern);
	if (!match) continue;
	const links = markdownLinks(match[5], root);
	backlogRows.push({
		id: match[1],
		status: match[3].trim(),
		link: links.length > 0 ? links[0] : undefined,
		line: line.trim(),
	});
}

const backlogById = new Map();
for (const row of backlogRows) {
	if (backlogById.has(row.id)) {
		failures.push(`BACKLOG.md: duplicate row for ${row.id}`);
	} else {
		backlogById.set(row.id, row);
	}
	if (!row.link) {
		failures.push(`BACKLOG.md: ${row.id} has no markdown link`);
		continue;
	}
	if (!existsSync(row.link.resolved) || !statSync(row.link.resolved).isFile()) {
		failures.push(`BACKLOG.md: ${row.id} links to missing file ${row.link.raw}`);
	}
}

for (const doc of featureDocs) {
	if (doc.topLevel && !backlogById.has(doc.id)) {
		failures.push(`docs/features/${doc.file}: top-level feature ${doc.id} is missing from BACKLOG.md`);
	}
}

const docsReadme = read(docsReadmePath, "docs/README.md");
const readmeLinks = markdownLinks(docsReadme, join(root, "docs"));
const readmeTargets = new Set(readmeLinks.map((link) => link.resolved));

for (const doc of featureDocs) {
	if (!readmeTargets.has(doc.path)) {
		failures.push(`docs/README.md: feature ${doc.id} (${doc.file}) is missing from the documentation index`);
	}
}

for (const link of readmeLinks) {
	if (!link.raw.startsWith("features/")) continue;
	if (!existsSync(link.resolved) || !statSync(link.resolved).isFile()) {
		failures.push(`docs/README.md: feature link points to missing file ${link.raw}`);
	}
}

for (const file of readdirSync(plansDir).filter((entry) => entry.endsWith(".md"))) {
	const planPath = join(plansDir, file);
	const plan = read(planPath, `docs/plans/${file}`);
	const featureLine = frontmatter(plan)
		.split("\n")
		.map((line) => line.match(/^feature:\s*(.+)$/))
		.find((match) => match !== null);
	if (!featureLine) continue;
	const featureId = featureLine[1].match(/F\d{3}/);
	if (!featureId) {
		failures.push(`docs/plans/${file}: feature field does not contain an Fxxx id`);
		continue;
	}
	const doc = featureById.get(featureId[0]);
	if (!doc || !doc.topLevel) {
		failures.push(`docs/plans/${file}: feature ${featureId[0]} has no docs/features/${featureId[0]}-*.md`);
	}
	if (!backlogById.has(featureId[0])) {
		failures.push(`docs/plans/${file}: feature ${featureId[0]} has no BACKLOG.md row`);
	}
}

if (failures.length > 0) {
	console.error("Document index check failed:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log(
	`Document index check passed: ${featureDocs.length} feature docs, ${backlogRows.length} BACKLOG rows.`,
);
