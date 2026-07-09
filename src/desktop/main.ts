import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWebServer, type StartedWebServer } from "../web/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let webServer: StartedWebServer | null = null;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");

function createMenu() {
  const isMac = process.platform === "darwin";

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" as const },
                { type: "separator" as const },
                { role: "services" as const },
                { type: "separator" as const },
                { role: "hide" as const },
                { role: "hideOthers" as const },
                { role: "unhide" as const },
                { type: "separator" as const },
                { role: "quit" as const },
              ],
            },
          ]
        : []),
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "窗口",
        submenu: [{ role: "minimize" }, { role: "close" }],
      },
    ]),
  );
}

async function createMainWindow() {
  if (!webServer) {
    webServer = await startWebServer({
      port: 0,
    });
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: "Code Agent",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(webServer.url);
}

async function stopWebServer() {
  if (!webServer) {
    return;
  }

  const server = webServer;
  webServer = null;
  await server.close();
}

app.setName("Code Agent");

async function boot() {
  createMenu();
  await createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
}

app.whenReady().then(() => {
  void boot().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Code Agent 启动失败", message);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (!webServer) {
    return;
  }

  event.preventDefault();
  void stopWebServer().finally(() => app.quit());
});
