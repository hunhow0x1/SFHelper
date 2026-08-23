import { createHash } from "node:crypto";

/** Account ids are never persisted in the clear: a snapshot the user shares
 *  in a bug report should not identify them, and nothing in the app needs
 *  the real id - only a stable key to tell two accounts apart. */
export function hashAccountId(accountId: string | null | undefined): string | null {
  const trimmed = accountId?.trim();
  if (!trimmed) return null;
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
}
