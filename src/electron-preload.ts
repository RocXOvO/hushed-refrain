import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preload scripts cannot require local modules at runtime, so these
// channel names intentionally stay self-contained here.
const DESKTOP_WINDOW_CHANNELS = {
  close: "desktop-window:close",
  getMaximized: "desktop-window:get-maximized",
  maximizedChanged: "desktop-window:maximized-changed",
  minimize: "desktop-window:minimize",
  toggleMaximize: "desktop-window:toggle-maximize",
} as const;

const DESKTOP_UPDATE_CHANNELS = {
  check: "desktop-update:check",
  download: "desktop-update:download",
  getState: "desktop-update:get-state",
  install: "desktop-update:install",
  stateChanged: "desktop-update:state-changed",
} as const;

const DESKTOP_EXPORT_CHANNELS = {
  resultsPdf: "desktop-export:results-pdf",
} as const;

contextBridge.exposeInMainWorld("ncmDesktop", Object.freeze({
  platform: process.platform,
  minimize: (): void => ipcRenderer.send(DESKTOP_WINDOW_CHANNELS.minimize),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(DESKTOP_WINDOW_CHANNELS.toggleMaximize),
  close: (): void => ipcRenderer.send(DESKTOP_WINDOW_CHANNELS.close),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke(DESKTOP_WINDOW_CHANNELS.getMaximized),
  onMaximizedChange: (listener: (maximized: boolean) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, maximized: boolean): void => listener(maximized);
    ipcRenderer.on(DESKTOP_WINDOW_CHANNELS.maximizedChanged, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_WINDOW_CHANNELS.maximizedChanged, wrapped);
  },
  getUpdateState: (): Promise<unknown> => ipcRenderer.invoke(DESKTOP_UPDATE_CHANNELS.getState),
  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke(DESKTOP_UPDATE_CHANNELS.check),
  downloadUpdate: (): Promise<unknown> => ipcRenderer.invoke(DESKTOP_UPDATE_CHANNELS.download),
  installUpdate: (): Promise<unknown> => ipcRenderer.invoke(DESKTOP_UPDATE_CHANNELS.install),
  exportResultsPdf: (request: unknown): Promise<unknown> => ipcRenderer.invoke(DESKTOP_EXPORT_CHANNELS.resultsPdf, request),
  onUpdateState: (listener: (state: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state);
    ipcRenderer.on(DESKTOP_UPDATE_CHANNELS.stateChanged, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_UPDATE_CHANNELS.stateChanged, wrapped);
  },
}));
