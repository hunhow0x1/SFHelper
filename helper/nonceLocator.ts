import type { ReadOnlyMemory, ScanHit } from "./memoryReader";

const TOKEN_RE = /-?\b[0-9]{6,24}\b|\b[0-9a-fA-F]{16,32}\b/g;

function tokensFrom(buf: Buffer): string[] {
  const text = buf.toString("latin1");
  return [...text.matchAll(TOKEN_RE)].map((m) => m[0]);
}

export async function findNonceCandidates(
  mem: ReadOnlyMemory,
  accountId: string,
  onProgress?: (scanned: number, total: number) => void,
): Promise<string[]> {
  const ranked = new Map<string, number>();
  const consider = (token: string, weight: number): void => {
    const prev = ranked.get(token) ?? 0;
    if (weight > prev) ranked.set(token, weight);
  };

  const harvest = (hits: ScanHit[], weight: number): void => {
    for (const hit of hits) {
      for (const token of tokensFrom(hit.trailing)) consider(token, weight);
    }
  };

  const [afterId, afterParam, afterKey] = await mem.scanMany(
    [
      { needle: Buffer.from(accountId, "latin1"), trailingBytes: 96 },
      { needle: Buffer.from("&nonce=", "latin1"), trailingBytes: 40 },
      { needle: Buffer.from("nonce", "latin1"), trailingBytes: 48 },
    ],
    { onProgress },
  );
  harvest(afterId ?? [], 3);
  harvest(afterParam ?? [], 3);
  harvest(afterKey ?? [], 1);

  ranked.delete(accountId);
  return [...ranked.entries()].sort((a, b) => b[1] - a[1]).map(([token]) => token);
}
