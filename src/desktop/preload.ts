import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("codeAgentDesktop", {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  selectDirectory: (initialPath?: string) => ipcRenderer.invoke("code-agent:select-directory", initialPath) as Promise<string | null>,
});
