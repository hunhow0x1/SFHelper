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

let dataRefreshedAt: number | null = null;

export function noteDataRefreshed(): void {
  dataRefreshedAt = Date.now();
}

export function getDataRefreshedAt(): number | null {
  return dataRefreshedAt;
}
