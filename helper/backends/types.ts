export interface MemoryRegion {
  start: number;
  end: number;
  perms: string;
  path: string | null;
}

export interface MemBackend {
  readonly pid: number;
  readonly regions: MemoryRegion[];
  read(address: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}
