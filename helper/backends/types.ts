/** Platform-agnostic, strictly READ-ONLY view of a process's memory.
 *
 *  Every backend that implements this may only read. There is no write method
 *  anywhere in this interface or its implementations - the same hard guarantee
 *  the Linux reader has always made, now upheld per-platform.
 */

export interface MemoryRegion {
  start: number;
  end: number;
  /** Linux-style permission string, e.g. "rw-p". Windows backends synthesize
   *  this so the shared scan filters work unchanged. */
  perms: string;
  /** Backing path for file-backed maps; null for private/anonymous memory. */
  path: string | null;
}

export interface MemBackend {
  readonly pid: number;
  readonly regions: MemoryRegion[];
  /** Read `length` bytes at absolute `address`. Read-only. */
  read(address: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}
