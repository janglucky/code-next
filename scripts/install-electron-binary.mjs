import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const electronRoot = path.join(process.cwd(), "node_modules", "electron");
const packagePath = path.join(electronRoot, "package.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    fail(result.error.message);
  }

  if (result.status !== 0) {
    fail(`${command} exited with code ${result.status}`);
  }
}

function artifactPlatform() {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "darwin";
    case "win32":
      return "win32";
    default:
      fail(`Unsupported Electron platform: ${process.platform}`);
  }
}

function artifactArch() {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    default:
      fail(`Unsupported Electron arch: ${process.arch}`);
  }
}

function executablePath() {
  switch (process.platform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      fail(`Unsupported Electron platform: ${process.platform}`);
  }
}

if (!fs.existsSync(packagePath)) {
  fail("Electron package is not installed. Run npm install first.");
}

if (process.platform === "win32") {
  fail("Manual Electron binary install currently requires curl and unzip; use npm run electron:rebuild on Windows.");
}

const electronPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const version = electronPackage.version;
const mirror = (process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/").replace(/\/?$/, "/");
const fileName = `electron-v${version}-${artifactPlatform()}-${artifactArch()}.zip`;
const url = `${mirror}${version}/${fileName}`;
const zipPath = path.join(os.tmpdir(), fileName);
const distPath = path.join(electronRoot, "dist");

console.log(`Downloading ${url}`);
run("curl", ["-L", "--fail", "-o", zipPath, url]);

fs.rmSync(distPath, { force: true, recursive: true });
fs.mkdirSync(distPath, { recursive: true });

console.log(`Extracting ${zipPath}`);
run("unzip", ["-q", zipPath, "-d", distPath]);

const executable = executablePath();
fs.writeFileSync(path.join(electronRoot, "path.txt"), executable);

if (process.platform !== "win32") {
  fs.chmodSync(path.join(distPath, executable), 0o755);
}

console.log(`Electron ${version} installed at ${path.join(distPath, executable)}`);
