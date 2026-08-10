import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preload scripts cannot require local modules at runtime, so these
// channel names intentionally stay self-contained here.
const DESKTOP_WINDOW_CHANNELS = {
  close: "desktop-window:close",
  closeDecision: "desktop-window:close-decision",
  closeRequested: "desktop-window:close-requested",
  getMaximized: "desktop-window:get-maximized",
  maximizedChanged: "desktop-window:maximized-changed",
  minimize: "desktop-window:minimize",
  toggleMaximize: "desktop-window:toggle-maximize",
} as const;

let closeRequestQueued = false;
let closeRequestedListener: (() => void) | undefined;
ipcRenderer.on(DESKTOP_WINDOW_CHANNELS.closeRequested, () => {
  if (closeRequestedListener) closeRequestedListener();
  else closeRequestQueued = true;
});

const DESKTOP_UPDATE_CHANNELS = {
  check: "desktop-update:check",
  download: "desktop-update:download",
  getState: "desktop-update:get-state",
  install: "desktop-update:install",
  stateChanged: "desktop-update:state-changed",
} as const;

const DESKTOP_SETTINGS_CHANNELS = {
  get: "desktop-settings:get",
  reset: "desktop-settings:reset",
  update: "desktop-settings:update",
} as const;

const DESKTOP_EXPORT_CHANNELS = {
  cancelResultsPdf: "desktop-export:cancel-results-pdf",
  resultsPdf: "desktop-export:results-pdf",
  resultsPdfProgress: "desktop-export:results-pdf-progress",
} as const;

contextBridge.exposeInMainWorld("ncmDesktop", Object.freeze({
  platform: process.platform,
  minimize: (): void => ipcRenderer.send(DESKTOP_WINDOW_CHANNELS.minimize),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(DESKTOP_WINDOW_CHANNELS.toggleMaximize),
  close: (): void => ipcRenderer.send(DESKTOP_WINDOW_CHANNELS.close),
  submitCloseDecision: (decision: unknown): Promise<boolean> => ipcRenderer.invoke(DESKTOP_WINDOW_CHANNELS.closeDecision, decision),
  onCloseRequested: (listener: () => void): (() => void) => {
    closeRequestedListener = listener;
    if (closeRequestQueued) {
      closeRequestQueued = false;
      queueMicrotask(() => {
        if (closeRequestedListener === listener) listener();
      });
    }
    return () => {
      if (closeRequestedListener === listener) closeRequestedListener = undefined;
    };
  },
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
  getSettings: (): Promise<unknown> => ipcRenderer.invoke(DESKTOP_SETTINGS_CHANNELS.get),
  updateSettings: (settings: unknown): Promise<unknown> => ipcRenderer.invoke(DESKTOP_SETTINGS_CHANNELS.update, settings),
  resetSettings: (): Promise<unknown> => ipcRenderer.invoke(DESKTOP_SETTINGS_CHANNELS.reset),
  exportResultsPdf: (request: unknown): Promise<unknown> => ipcRenderer.invoke(DESKTOP_EXPORT_CHANNELS.resultsPdf, request),
  cancelResultsPdf: (): Promise<unknown> => ipcRenderer.invoke(DESKTOP_EXPORT_CHANNELS.cancelResultsPdf),
  onResultsPdfProgress: (listener: (progress: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: unknown): void => listener(progress);
    ipcRenderer.on(DESKTOP_EXPORT_CHANNELS.resultsPdfProgress, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_EXPORT_CHANNELS.resultsPdfProgress, wrapped);
  },
  onUpdateState: (listener: (state: unknown) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown): void => listener(state);
    ipcRenderer.on(DESKTOP_UPDATE_CHANNELS.stateChanged, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_UPDATE_CHANNELS.stateChanged, wrapped);
  },
}));
