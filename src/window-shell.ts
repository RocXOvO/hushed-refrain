import type { BrowserWindowConstructorOptions } from "electron";

export const DESKTOP_WINDOW_CHANNELS = {
  close: "desktop-window:close",
  getMaximized: "desktop-window:get-maximized",
  maximizedChanged: "desktop-window:maximized-changed",
  minimize: "desktop-window:minimize",
  toggleMaximize: "desktop-window:toggle-maximize",
} as const;

export function desktopWindowChrome(platform: NodeJS.Platform): Pick<BrowserWindowConstructorOptions, "frame"> {
  return platform === "win32" ? { frame: false } : {};
}

export function desktopDashboardUrl(origin: string, platform: NodeJS.Platform): string {
  const url = new URL(origin);
  url.searchParams.set("desktop", platform);
  return url.toString();
}
