/** Live status of the desktop app's self-update, for the dashboard.
 *
 *  The Electron main process runs the updater (electron/updater.ts) and
 *  reports here; the server exposes it at /api/update, and passes the page's
 *  "Check for updates" / "Restart to update" clicks back through the handler
 *  the main process registers. Null in the plain browser build, which can't
 *  update itself.
 */

export interface UpdateStatus {
  /** The running version. */
  current: string;
  state: "unsupported" | "idle" | "checking" | "downloading" | "ready" | "latest" | "error";
  /** The newer version, once one is found. */
  version?: string;
  /** Download progress, 0-100. */
  percent?: number;
  /** Why updates are unavailable, or what went wrong. */
  message?: string;
  at: string;
}

export type UpdateAction = "check" | "install";

let status: UpdateStatus | null = null;
let handler: ((action: UpdateAction) => void) | null = null;

export function getUpdateStatus(): UpdateStatus | null {
  return status;
}

export function setUpdateStatus(s: Omit<UpdateStatus, "at">): void {
  status = { ...s, at: new Date().toISOString() };
}

/** The main process's handler for the page's update buttons. */
export function onUpdateAction(fn: (action: UpdateAction) => void): void {
  handler = fn;
}

/** Pass a button click on; false when nothing can act on it. */
export function requestUpdateAction(action: UpdateAction): boolean {
  if (!handler) return false;
  handler(action);
  return true;
}
