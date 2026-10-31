export interface UpdateStatus {
  current: string;
  state: "unsupported" | "idle" | "checking" | "downloading" | "ready" | "latest" | "error";
  version?: string;
  percent?: number;
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

export function onUpdateAction(fn: (action: UpdateAction) => void): void {
  handler = fn;
}

export function requestUpdateAction(action: UpdateAction): boolean {
  if (!handler) return false;
  handler(action);
  return true;
}
