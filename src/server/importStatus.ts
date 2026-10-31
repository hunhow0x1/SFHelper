export interface ImportStatus {
  state: "scanning" | "ok" | "error";
  message: string;
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
