import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const testsRoot = join(projectRoot, "dist", "tests");
const requestedSuite = process.argv[2];

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.js"))
      files.push(path);
  }
  return files;
}

const allTests = await collect(testsRoot);
const selected = requestedSuite
  ? allTests.filter((path) =>
      relative(testsRoot, path).startsWith(`${requestedSuite}${"\\"}`),
    )
  : allTests;

if (selected.length === 0) {
  console.error(
    `No compiled tests found for suite '${requestedSuite ?? "all"}'.`,
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", ...selected], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
}
