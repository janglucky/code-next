import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const electronRoot = path.join(process.cwd(), "node_modules", "electron");
const pathFile = path.join(electronRoot, "path.txt");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function fixMessage(detail) {
  return [
    detail,
    "",
    "Electron binary is missing. Run:",
    "  npm run electron:rebuild",
    "",
    "If you are behind a proxy, export proxy variables first, for example:",
    "  export HTTPS_PROXY=http://127.0.0.1:7890",
    "  export HTTP_PROXY=http://127.0.0.1:7890",
    "  npm run electron:rebuild",
    "",
    "If GitHub release downloads are blocked, try a mirror:",
    "  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run electron:rebuild",
    "",
    "If the npm downloader hangs, use the curl/unzip installer:",
    "  npm run electron:install",
  ].join("\n");
}

if (!fs.existsSync(electronRoot)) {
  fail(fixMessage("Electron package is not installed."));
}

const executableName = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, "utf8").trim() : "electron";
const distRoot = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronRoot, "dist");
const executablePath = path.join(distRoot, executableName);

if (!fs.existsSync(pathFile) && !process.env.ELECTRON_OVERRIDE_DIST_PATH) {
  fail(fixMessage("node_modules/electron/path.txt was not found."));
}

if (!fs.existsSync(executablePath)) {
  fail(fixMessage(`Electron executable was not found at ${executablePath}.`));
}
