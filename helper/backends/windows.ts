/** Windows read-only memory backend via kernel32 (koffi FFI).
 *
 *  The process is opened with PROCESS_VM_READ | PROCESS_QUERY_INFORMATION only -
 *  NOT PROCESS_VM_WRITE or PROCESS_VM_OPERATION - so this handle is physically
 *  incapable of writing to the target. Reads go through ReadProcessMemory; region
 *  enumeration through VirtualQueryEx. No write API is imported anywhere here.
 *
 *  koffi ships prebuilt binaries (no node-gyp), so this needs no build toolchain
 *  on the user's machine. x64 only (Soulframe is a 64-bit title).
 *
 *  NOTE: written to the Win32 spec; validate on a Windows host.
 */

import { createRequire } from "node:module";
import type { MemBackend, MemoryRegion } from "./types";

// koffi is a CommonJS native module; load it through createRequire so this works
// whether the app runs as ESM or is bundled. Only ever reached on Windows.
const nodeRequire = createRequire(import.meta.url);

// Access rights (winnt.h)
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
// Memory state / protection (winnt.h)
const MEM_COMMIT = 0x1000;
const MEM_PRIVATE = 0x20000;
const PAGE_GUARD = 0x100;
const PAGE_NOACCESS = 0x01;
// Protections that permit reading (any of these, unless guarded/noaccess).
const READABLE = new Set([0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]); // R, RW, WC, XR, XRW, X? see below
const WRITABLE = new Set([0x04, 0x08, 0x40, 0x80]); // RW, WC, EX_RW, EX_WC
// PAGE_READONLY=0x02 PAGE_READWRITE=0x04 PAGE_WRITECOPY=0x08
// PAGE_EXECUTE=0x10 PAGE_EXECUTE_READ=0x20 PAGE_EXECUTE_READWRITE=0x40 PAGE_EXECUTE_WRITECOPY=0x80

const MAX_USER_ADDR = 0x7fffffff0000; // top of x64 user address space

interface K32 {
  OpenProcess: (access: number, inherit: boolean, pid: number) => unknown;
  ReadProcessMemory: (h: unknown, addr: number, buf: Buffer, size: number, read: number[]) => boolean;
  VirtualQueryEx: (h: unknown, addr: number, mbi: Record<string, number>, len: number) => number;
  CloseHandle: (h: unknown) => boolean;
  mbiSize: number;
}

let cached: K32 | null = null;

function loadKernel32(): K32 {
  if (cached) return cached;
  // Lazy require so non-Windows platforms never load koffi.
  const koffi = nodeRequire("koffi") as typeof import("koffi");
  const k32 = koffi.load("kernel32.dll");
  const MBI = koffi.struct("MEMORY_BASIC_INFORMATION", {
    BaseAddress: "size_t",
    AllocationBase: "size_t",
    AllocationProtect: "uint32",
    PartitionId: "uint16",
    __pad: "uint16",
    RegionSize: "size_t",
    State: "uint32",
    Protect: "uint32",
    Type: "uint32",
    __pad2: "uint32",
  });
  cached = {
    OpenProcess: k32.func("void *OpenProcess(uint32, bool, uint32)") as K32["OpenProcess"],
    ReadProcessMemory: k32.func(
      "bool ReadProcessMemory(void *, size_t, _Out_ void *, size_t, _Out_ size_t *)",
    ) as K32["ReadProcessMemory"],
    VirtualQueryEx: k32.func(
      `size_t VirtualQueryEx(void *, size_t, _Out_ MEMORY_BASIC_INFORMATION *, size_t)`,
    ) as K32["VirtualQueryEx"],
    CloseHandle: k32.func("bool CloseHandle(void *)") as K32["CloseHandle"],
    mbiSize: koffi.sizeof(MBI),
  };
  return cached;
}

class WindowsBackend implements MemBackend {
  constructor(
    readonly pid: number,
    private readonly handle: unknown,
    readonly regions: MemoryRegion[],
    private readonly k32: K32,
  ) {}

  async read(address: number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length);
    const read = [0];
    const ok = this.k32.ReadProcessMemory(this.handle, address, buf, length, read);
    if (!ok) throw new Error(`ReadProcessMemory failed at 0x${address.toString(16)}`);
    return read[0] && read[0] < length ? buf.subarray(0, read[0]) : buf;
  }

  async close(): Promise<void> {
    this.k32.CloseHandle(this.handle);
  }
}

function enumerateRegions(k32: K32, handle: unknown): MemoryRegion[] {
  const regions: MemoryRegion[] = [];
  let addr = 0;
  while (addr < MAX_USER_ADDR) {
    const mbi: Record<string, number> = {};
    const n = k32.VirtualQueryEx(handle, addr, mbi, k32.mbiSize);
    if (!n) break;
    const base = Number(mbi.BaseAddress ?? 0);
    const size = Number(mbi.RegionSize ?? 0);
    if (!size) break;
    const protectFull = mbi.Protect ?? 0;
    const protect = protectFull & 0xff;
    const guarded = (protectFull & PAGE_GUARD) !== 0 || protect === PAGE_NOACCESS;
    if (mbi.State === MEM_COMMIT && !guarded && READABLE.has(protect)) {
      const w = WRITABLE.has(protect);
      const priv = mbi.Type === MEM_PRIVATE;
      regions.push({
        start: base,
        end: base + size,
        // Synthesize a Linux-style perm string so shared scan filters work.
        perms: `r${w ? "w" : "-"}-${priv ? "p" : "s"}`,
        path: priv ? null : "[mapped]",
      });
    }
    addr = base + size;
  }
  return regions;
}

export async function openWindows(pid: number): Promise<MemBackend> {
  const k32 = loadKernel32();
  const handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
  if (!handle) throw new Error(`OpenProcess(${pid}) failed (run as the same user / as admin)`);
  const regions = enumerateRegions(k32, handle);
  return new WindowsBackend(pid, handle, regions, k32);
}
