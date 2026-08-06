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
}));
