import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dependencyNames = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {})
];
const forbiddenPackages = ["p" + "g", "post" + "gres", "drizzle" + "-orm"];
const dependencyMatches = dependencyNames.filter((name) =>
  forbiddenPackages.some((forbidden) => name === forbidden || name.startsWith(`${forbidden}-`))
);
const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const transitiveMatches = Object.keys(lockfile.packages ?? {})
  .filter((path) => path.startsWith("node_modules/"))
  .map((path) => path.slice("node_modules/".length))
  .filter((name) =>
    forbiddenPackages.some(
      (forbidden) => name === forbidden || name.startsWith(`${forbidden}-`)
    )
  );

const sourceRoots = ["src", "server", "lib", "scripts", "test"];
const extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const findings = [];

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!extensions.has(extname(path)) || entry.name === "check-no-postgres.mjs") continue;
    const content = await readFile(path, "utf8");
    const patterns = [
      /from\s+["']p[g]["']/,
      /from\s+["']post(?:gres|gresql)["']/,
      /from\s+["']drizzle-/,
      /require\(["']p[g]["']\)/,
      /postgres(?:ql)?:\/\//
    ];
    if (patterns.some((pattern) => pattern.test(content))) {
      findings.push(relative(root, path));
    }
  }
}

for (const sourceRoot of sourceRoots) {
  try {
    await scan(join(root, sourceRoot));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (dependencyMatches.length > 0 || transitiveMatches.length > 0 || findings.length > 0) {
  console.error(
    JSON.stringify(
      {
        forbiddenDependencies: dependencyMatches,
        forbiddenTransitivePackages: transitiveMatches,
        forbiddenCode: findings
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} else {
  console.log("No PostgreSQL or Drizzle packages/code found.");
}
