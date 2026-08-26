import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const ignored = new Set(["node_modules", ".git", "dist", "coverage"]);
const extensions = new Set([".ts", ".mjs", ".json", ".md", ".yaml", ".yml"]);
const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!extensions.has(entry.name.slice(entry.name.lastIndexOf("."))))
      continue;
    const content = await readFile(path, "utf8");
    content.split(/\r?\n/).forEach((line, index) => {
      if (/\s+$/.test(line))
        violations.push(`${path}:${index + 1}: trailing whitespace`);
    });
  }
}

await visit(root);
if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("lint PASS");
}
