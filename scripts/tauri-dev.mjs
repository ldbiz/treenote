import { spawn } from "node:child_process";

process.env.TREENOTE_DEV_MODE = "1";

const child = spawn("npx", ["tauri", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
