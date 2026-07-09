import { spawn } from "node:child_process";
import process from "node:process";

const env = { ...process.env };

env.HTTPS_PROXY ||= env.https_proxy;
env.HTTP_PROXY ||= env.http_proxy;
env.ALL_PROXY ||= env.all_proxy;
env.NO_PROXY ||= env.no_proxy;

if (env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY) {
  env.ELECTRON_GET_USE_PROXY ||= "1";
}

const child = spawn("npm", ["rebuild", "electron"], {
  env,
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
