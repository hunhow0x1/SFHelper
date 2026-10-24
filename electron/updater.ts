/** Self-update from this repo's GitHub Releases (electron-updater).
 *
 *  Works for the Windows installer and the AppImage: each release carries
 *  latest.yml / latest-linux.yml, which electron-builder writes next to the
 *  builds (see the "publish" setting in package.json). The portable zip and
 *  development runs can't replace themselves, so they only report that.
 *
 *  Checks at launch and every few hours, downloads in the background, and
 *  installs when the app quits - or straight away from the dashboard's
 *  "Restart to update" button. The check sends nothing about the user.
 */

import { app } from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import electronUpdater, { type ProgressInfo, type UpdateInfo } from "electron-updater";
import { onUpdateAction, setUpdateStatus, type UpdateStatus } from "../src/server/updateStatus";

const CHECK_INTERVAL_MS = 6 * 3600_000;

/** Why this copy can't update itself, or null if it can. */
function unsupportedReason(): string | null {
  if (!app.isPackaged) return "Updates are off when running from source.";
  if (process.platform === "linux" && !process.env.APPIMAGE) return "Only the AppImage can update itself.";
  if (process.platform === "win32" && !existsSync(join(dirname(process.execPath), "Uninstall SFHelper.exe"))) {
    return "The portable version can't update itself. Install SFHelper with the Setup exe to get updates.";
  }
  return null;
}

export function startUpdater(log: (msg: string) => void): void {
  const current = app.getVersion();
  let state: Omit<UpdateStatus, "at"> = { current, state: "idle" };
  const report = (s: Omit<UpdateStatus, "at" | "current">) => {
    state = { current, ...s };
    setUpdateStatus(state);
  };

  const reason = unsupportedReason();
  if (reason) {
    report({ state: "unsupported", message: reason });
    log(`Updates: ${reason}`);
    return;
  }

  // Created on first access, for this platform (NSIS or AppImage).
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = { info: (m) => log(`Updates: ${m}`), warn: (m) => log(`Updates: ${m}`), error: (m) => log(`Updates: ${m}`), debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    if (state.state !== "downloading" && state.state !== "ready") report({ state: "checking" });
  });
  autoUpdater.on("update-not-available", () => report({ state: "latest" }));
  autoUpdater.on("update-available", (info: UpdateInfo) => report({ state: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (p: ProgressInfo) => {
    report({ state: "downloading", ...(state.version ? { version: state.version } : {}), percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info: UpdateInfo) => report({ state: "ready", version: info.version }));
  autoUpdater.on("error", (err: Error) => {
    // A failed background check shouldn't hide an update that's already downloaded.
    if (state.state !== "ready") report({ state: "error", message: err.message.split("\n")[0] ?? "Update check failed." });
  });

  const check = () => {
    if (state.state === "downloading" || state.state === "ready") return;
    autoUpdater.checkForUpdates().catch(() => {}); // reported through the "error" event
  };
  onUpdateAction((action) => {
    if (action === "check") check();
    else if (state.state === "ready") {
      log(`Updates: restarting to install ${state.version}.`);
      autoUpdater.quitAndInstall(true, true);
    }
  });

  report({ state: "idle" });
  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
