import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viteInstalled = existsSync(join(root, "node_modules", "vite", "package.json"));

if (viteInstalled) {
  process.exit(0);
}

console.log("Frontend dependencies are missing. Running npm install…\n");

const result = spawnSync("npm", ["install"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  console.error("\nnpm install failed. Fix the error above, then try again.");
  process.exit(result.status ?? 1);
}

if (!existsSync(join(root, "node_modules", "vite", "package.json"))) {
  console.error("\nnpm install finished but vite is still missing.");
  process.exit(1);
}

console.log("\nDependencies installed.\n");
