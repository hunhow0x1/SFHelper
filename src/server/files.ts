import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let seq = 0;
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++seq}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt < 5 && RETRYABLE.has(code)) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
}
