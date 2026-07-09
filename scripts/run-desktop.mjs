import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const electronBin = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      stdio: "inherit",
      ...options,
    });

    child.on("exit", (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
  });
}

const check = await run(process.execPath, ["scripts/check-electron.mjs"]);

if (check.signal) {
  process.kill(process.pid, check.signal);
}

if (check.code !== 0) {
  process.exit(check.code);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const desktop = await run(electronBin, ["dist/desktop/main.js"], { env });

if (desktop.signal) {
  process.kill(process.pid, desktop.signal);
}

process.exit(desktop.code);
