/** Live status of the desktop app's memory import, for the dashboard.
 *
 *  The Electron main process runs the import and reports here; the server
 *  exposes it at /api/import-status so the page can say what is happening
 *  ("Soulframe isn't running", "Couldn't read the game's memory"...) instead
 *  of waiting silently. Null when no import has run (e.g. the plain browser
 *  build, which has no memory import at all).
 */

export interface ImportStatus {
  state: "scanning" | "ok" | "error";
  message: string;
  /** The importer's result code on error (see helper/run.ts). */
  code?: number;
  at: string;
}

let status: ImportStatus | null = null;

export function getImportStatus(): ImportStatus | null {
  return status;
}

export function setImportStatus(s: Omit<ImportStatus, "at">): void {
  status = { ...s, at: new Date().toISOString() };
}
