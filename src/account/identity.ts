import { createHash } from "node:crypto";

export function hashAccountId(accountId: string | null | undefined): string | null {
  const trimmed = accountId?.trim();
  if (!trimmed) return null;
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
}
