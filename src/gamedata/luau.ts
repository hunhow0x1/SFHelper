import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readEntry, tocIndex, type TocEntry } from "./cache";

export class Hashed {
  constructor(readonly h: number) {}
}

export class LuaTable {
  readonly map = new Map<unknown, [Value, Value]>();
  meta: LuaTable | null = null;
}

class Upval {
  constructor(
    public regs: Value[] | null,
    readonly i: number,
    public v: Value,
  ) {}
  get(): Value {
    return this.regs ? this.regs[this.i] : this.v;
  }
  set(x: Value): void {
    if (this.regs) this.regs[this.i] = x;
    else this.v = x;
  }
  close(): void {
    if (!this.regs) return;
    this.v = this.regs[this.i];
    this.regs = null;
  }
}

class Closure {
  constructor(
    readonly chunk: Chunk,
    readonly proto: Proto,
    readonly ups: Upval[],
    readonly env: LuaTable,
  ) {}
}

type Native = (...args: Value[]) => Value[];
export type Value = undefined | boolean | number | string | Hashed | LuaTable | Closure | Native;

class Imp {
  constructor(readonly id: number) {}
}
class Clo {
  constructor(readonly p: number) {}
}
type Konst = Value | Imp | Clo;

interface Proto {
  maxstack: number;
  nparams: number;
  nups: number;
  vararg: boolean;
  code: Int32Array;
  k: Konst[];
  children: number[];
}

export interface Chunk {
  name?: string;
  strings: string[];
  protos: Proto[];
  main: number;
}

export function parseChunk(buf: Buffer): Chunk {
  let i = 0;
  const u8 = (): number => buf[i++]!;
  const varint = (): number => {
    let r = 0;
    let s = 0;
    let c: number;
    do {
      c = u8();
      r |= (c & 127) << s;
      s += 7;
    } while (c & 128);
    return r >>> 0;
  };
  const version = u8();
  if (version < 3 || version > 6) throw new Error(`unsupported script version ${version}`);
  const types = version >= 4 ? u8() : 0;
  const strings = Array.from({ length: varint() }, () => {
    const n = varint();
    i += n;
    return buf.toString("latin1", i - n, i);
  });
  if (types === 3) while (u8()) varint();
  const protos: Proto[] = [];
  for (let n = varint(); n > 0; n--) {
    const maxstack = u8();
    const nparams = u8();
    const nups = u8();
    const vararg = u8() !== 0;
    if (version >= 4) {
      u8();
      const typeSize = varint();
      i += typeSize;
    }
    const size = varint();
    const code = new Int32Array(size);
    for (let j = 0; j < size; j++, i += 4) code[j] = buf.readInt32LE(i);
    const k: Konst[] = [];
    for (let j = varint(); j > 0; j--) {
      const t = u8();
      if (t === 0) k.push(undefined);
      else if (t === 1) k.push(new Hashed(buf.readUInt32LE((i += 4) - 4)));
      else if (t === 2) k.push(buf.readDoubleLE((i += 8) - 8));
      else if (t === 3) {
        const s = varint();
        k.push(s ? strings[s - 1] : undefined);
      } else if (t === 4) k.push(new Imp(buf.readUInt32LE((i += 4) - 4)));
      else if (t === 5) {
        for (let m = varint(); m > 0; m--) varint();
        k.push(undefined);
      } else if (t === 6) k.push(new Clo(varint()));
      else if (t === 7) {
        i += 16;
        k.push(undefined);
      } else if (t === 8) {
        for (let m = varint(); m > 0; m--, i += 4) varint();
        k.push(undefined);
      } else throw new Error(`unknown constant type ${t}`);
    }
    const children = Array.from({ length: varint() }, () => varint());
    varint();
    varint();
    if (u8()) {
      const gap = u8();
      i += size + 4 * (((size - 1) >> gap) + 1);
    }
    if (u8()) {
      for (let m = varint(); m > 0; m--) {
        varint();
        varint();
        varint();
        u8();
      }
      for (let m = varint(); m > 0; m--) varint();
    }
    protos.push({ maxstack, nparams, nups, vararg, code, k, children });
  }
  return { strings, protos, main: varint() };
}

const OPS: Record<string, number> = {
  SETGLOBAL: 0x00,
  SETLIST: 0x03,
  DUPCLOSURE: 0x04,
  LOADNIL: 0x05,
  CAPTURE: 0x06,
  JUMPIFNOTEQ: 0x08,
  PREPVARARGS: 0x09,
  GETTABLEKS: 0x0a,
  GETIMPORT: 0x0b,
  CONCAT: 0x0c,
  CALL: 0x0d,
  NEWTABLE: 0x0e,
  MOVE: 0x11,
  DIVRK: 0x12,
  MUL: 0x15,
  ADD: 0x1a,
  LOADB: 0x18,
  JUMPIFEQ: 0x26,
  JUMPXEQKN: 0x1d,
  JUMPIFNOTLT: 0x1f,
  JUMPBACK: 0x20,
  FORNPREP: 0x21,
  SETUPVAL: 0x22,
  FASTCALL1: 0x23,
  FASTCALL: 0x25,
  JUMPIFNOTLE: 0x1b,
  DIVK: 0x27,
  LOADK: 0x28,
  LOADN: 0x29,
  JUMPIFNOT: 0x2d,
  SUBRK: 0x2e,
  ADDK: 0x2f,
  GETVARARGS: 0x31,
  FORGPREP_INEXT: 0x34,
  NEWCLOSURE: 0x36,
  FORGLOOP: 0x37,
  ORK: 0x38,
  JUMPXEQKNIL: 0x39,
  FORNLOOP: 0x3a,
  JUMPIFLE: 0x3b,
  RETURN: 0x3c,
  SETTABLEKS: 0x3f,
  FORGPREP_NEXT: 0x40,
  MODK: 0x42,
  CLOSEUPVALS: 0x43,
  JUMPIF: 0x44,
  GETUPVAL: 0x46,
  JUMP: 0x47,
  JUMPXEQKB: 0x48,
  JUMPIFLT: 0x49,
  DUPTABLE: 0x4a,
  MULK: 0x4b,
  JUMPXEQKS: 0x4c,
  SUBK: 0x4d,
  NAMECALL: 0x50,
  GETGLOBAL: 0x51,
};
const OP_NAME: string[] = [];
for (const [name, code] of Object.entries(OPS)) OP_NAME[code] = name;

const truthy = (v: Value): boolean => v !== undefined && v !== false;

const keyOf = (v: Value): unknown => (v instanceof Hashed ? `#${v.h}` : typeof v === "string" ? `$${v}` : v);

export function luaGet(t: LuaTable, key: Value): Value {
  return t.map.get(keyOf(key))?.[1];
}

export function luaSet(t: LuaTable, key: Value, v: Value): void {
  if (v === undefined) t.map.delete(keyOf(key));
  else t.map.set(keyOf(key), [key, v]);
}

export function luaTable(entries: Record<string, Value>): LuaTable {
  const t = new LuaTable();
  for (const [k, v] of Object.entries(entries)) luaSet(t, k, v);
  return t;
}

const numText = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number.parseFloat(n.toPrecision(14))));

export function luaText(v: Value): string {
  if (typeof v === "number") return numText(v);
  if (typeof v === "string") return v;
  if (v === undefined) return "nil";
  if (typeof v === "boolean") return String(v);
  return "?";
}

const ENGINE: Map<number, Native> = new Map([
  [0x4d44f7b8, (v: Value, places: Value) => [typeof v === "number" ? Number(v.toFixed(typeof places === "number" ? places : 0)) : v]],
]);

const BUILTINS: Record<number, Native> = {
  2: (v) => [Math.abs(Number(v))],
  7: (v) => [Math.ceil(Number(v))],
  12: (v) => [Math.floor(Number(v))],
  18: (...v) => [Math.max(...v.map(Number))],
  19: (...v) => [Math.min(...v.map(Number))],
  46: (v, lo, hi) => [Math.min(Math.max(Number(v), Number(lo)), Number(hi))],
  48: (v) => [Math.round(Number(v))],
  62: (v) => [typeof v === "number" ? v : Number.isFinite(Number(v)) ? Number(v) : undefined],
  63: (v) => [luaText(v)],
};

export class LuaError extends Error {}

const STEP_LIMIT = 200_000;

export class LuaVM {
  private steps = 0;
  private readonly loaded = new Map<string, Value>();
  private readonly modules = new Set<LuaTable>();

  private readonly paramValues = new Set<string>();
  private readonly probes = new Map<number, Native>();

  constructor(private readonly scripts: Map<string, Chunk>) {}

  static modulePath(name: string): string {
    return `/${name.replace(/\./g, "/")}.lua`;
  }

  load(path: string, params?: LuaTable): LuaTable {
    const chunk = this.scripts.get(path);
    if (!chunk) throw new LuaError(`script ${path} not found`);
    const env = new LuaTable();
    if (params) for (const [, v] of params.map.values()) if (typeof v === "string" && v) this.paramValues.add(v);
    this.modules.add(env);
    this.loaded.set(path, env);
    const result = this.call(new Closure(chunk, chunk.protos[chunk.main]!, [], env), [])[0];
    if (result !== undefined) this.loaded.set(path, result);
    if (result instanceof LuaTable) this.modules.add(result);
    return env;
  }

  private probe(name: Hashed): Native {
    let f = this.probes.get(name.h);
    if (!f) {
      f = (...args: Value[]) => this.stub(...args);
      this.probes.set(name.h, f);
    }
    return f;
  }

  private readonly stub: Native = (...args) => {
    const name = args[0];
    if (args.length === 1 && typeof name === "string" && /^\w+(\.\w+)+$/.test(name)) {
      const path = LuaVM.modulePath(name);
      if (this.loaded.has(path)) return [this.loaded.get(path)];
      if (this.scripts.has(path)) {
        try {
          this.load(path);
        } catch (e) {
          if (!(e instanceof LuaError)) throw e;
        }
        return [this.loaded.get(path)];
      }
    }
    return args;
  };

  private global(env: LuaTable, name: Value): Value {
    const v = luaGet(env, name);
    if (v !== undefined) return v;
    return name instanceof Hashed ? this.probe(name) : this.stub;
  }

  index(obj: Value, key: Value): Value {
    if (obj instanceof LuaTable) {
      const v = luaGet(obj, key);
      if (v === undefined && key instanceof Hashed && this.modules.has(obj)) return ENGINE.get(key.h) ?? this.stub;
      if (v !== undefined || !obj.meta) return v;
      const idx = luaGet(obj.meta, "__index");
      if (idx instanceof LuaTable) return this.index(idx, key);
      if (idx !== undefined) return this.call(idx, [obj, key])[0];
      return undefined;
    }
    if (typeof obj === "function" || typeof obj === "string") return this.stub;
    throw new LuaError(`cannot index ${luaText(obj)}`);
  }

  call(fn: Value, args: Value[]): Value[] {
    if (typeof fn === "function") return fn(...args);
    if (fn instanceof Closure) return this.run(fn, args);
    throw new LuaError(`cannot call ${luaText(fn)}`);
  }

  private run(cl: Closure, args: Value[]): Value[] {
    try {
      return this.exec(cl, args);
    } catch (e) {
      if (e instanceof LuaError && !e.message.includes(" in /")) throw new LuaError(`${e.message} in ${cl.chunk.name ?? "?"}#${cl.chunk.protos.indexOf(cl.proto)}`);
      throw e;
    }
  }

  private exec(cl: Closure, args: Value[]): Value[] {
    const { proto: p, chunk } = cl;
    const { code } = p;
    const k = p.k as Value[];
    const R: Value[] = new Array<Value>(Math.max(p.maxstack, 1)).fill(undefined);
    for (let i = 0; i < p.nparams; i++) R[i] = args[i];
    const varargs = p.vararg ? args.slice(p.nparams) : [];
    const open = new Map<number, Upval>();
    let top = 0;
    let pc = 0;
    const arith = (op: string, x: Value, y: Value): number => {
      const unknown = (v: Value) => v === undefined || typeof v === "function";
      if (unknown(y) && typeof x === "number" && op !== "POW") return x;
      if (unknown(x) && typeof y === "number" && (op === "ADD" || op === "MUL")) return y;
      const a = Number(x);
      const b = Number(y);
      switch (op) {
        case "ADD":
          return a + b;
        case "SUB":
          return a - b;
        case "MUL":
          return a * b;
        case "DIV":
          return a / b;
        case "MOD":
          return a - Math.floor(a / b) * b;
        case "POW":
          return a ** b;
        default:
          return Math.floor(a / b);
      }
    };
    const closure = (proto: Proto): Closure => {
      const ups: Upval[] = [];
      for (let c = 0; c < proto.nups; c++) {
        const w = code[pc++]!;
        if (OP_NAME[w & 255] !== "CAPTURE") throw new LuaError("closure without captures");
        const type = (w >>> 8) & 255;
        const b = (w >>> 16) & 255;
        if (type === 0) ups.push(new Upval(null, 0, R[b]));
        else if (type === 1) {
          const u = open.get(b) ?? new Upval(R, b, undefined);
          open.set(b, u);
          ups.push(u);
        } else ups.push(cl.ups[b]!);
      }
      return new Closure(chunk, proto, ups, cl.env);
    };
    const place = (at: number, res: Value[], want: number): void => {
      if (want < 0) {
        for (let j = 0; j < res.length; j++) R[at + j] = res[j];
        top = at + res.length;
      } else for (let j = 0; j < want; j++) R[at + j] = res[j];
    };
    for (;;) {
      if (++this.steps > STEP_LIMIT) throw new LuaError("script ran too long");
      const at = pc;
      const w = code[pc++];
      if (w === undefined) throw new LuaError("ran off the end of a function");
      const name = OP_NAME[w & 255];
      const A = (w >>> 8) & 255;
      const B = (w >>> 16) & 255;
      const C = w >>> 24;
      const D = w >> 16;
      const aux = (): number => code[pc++]! >>> 0;
      const jump = (): void => {
        pc = at + 1 + D;
      };
      switch (name) {
        case "LOADNIL":
          R[A] = undefined;
          break;
        case "LOADB":
          R[A] = B !== 0;
          pc += C;
          break;
        case "LOADN":
          R[A] = D;
          break;
        case "LOADK":
          R[A] = k[D];
          break;
        case "LOADKX":
          R[A] = k[aux()];
          break;
        case "MOVE":
          R[A] = R[B];
          break;
        case "GETGLOBAL":
          R[A] = this.global(cl.env, k[aux()]);
          break;
        case "SETGLOBAL":
          luaSet(cl.env, k[aux()], R[A]);
          break;
        case "GETUPVAL":
          R[A] = cl.ups[B]!.get();
          break;
        case "SETUPVAL":
          cl.ups[B]!.set(R[A]);
          break;
        case "CLOSEUPVALS":
          for (const [r, u] of open)
            if (r >= A) {
              u.close();
              open.delete(r);
            }
          break;
        case "GETIMPORT": {
          const id = aux();
          const n = id >>> 30;
          const path = [(id >>> 20) & 1023, (id >>> 10) & 1023, id & 1023].slice(0, n).map((x) => k[x]);
          let v = this.global(cl.env, path[0]);
          for (const part of path.slice(1)) v = this.index(v, part);
          R[A] = v;
          break;
        }
        case "GETTABLE":
          R[A] = this.index(R[B], R[C]);
          break;
        case "SETTABLE":
          this.assign(R[B], R[C], R[A]);
          break;
        case "GETTABLEKS":
          R[A] = this.index(R[B], k[aux()]);
          break;
        case "SETTABLEKS":
          this.assign(R[B], k[aux()], R[A]);
          break;
        case "GETTABLEN":
          R[A] = this.index(R[B], C + 1);
          break;
        case "SETTABLEN":
          this.assign(R[B], C + 1, R[A]);
          break;
        case "NEWCLOSURE":
          R[A] = closure(chunk.protos[p.children[D]!]!);
          break;
        case "DUPCLOSURE":
          R[A] = closure(chunk.protos[(p.k[D] as Clo).p]!);
          break;
        case "NAMECALL": {
          const obj = R[B];
          R[A + 1] = obj;
          R[A] = this.index(obj, k[aux()]);
          break;
        }
        case "CALL": {
          const n = B ? B - 1 : top - A - 1;
          place(A, this.call(R[A], R.slice(A + 1, A + 1 + n)), C - 1);
          break;
        }
        case "RETURN":
          return R.slice(A, A + (B ? B - 1 : top - A));
        case "JUMP":
        case "JUMPBACK":
          jump();
          break;
        case "JUMPX":
          pc = at + 1 + (w >> 8);
          break;
        case "JUMPIF":
          if (truthy(R[A])) jump();
          break;
        case "JUMPIFNOT":
          if (!truthy(R[A])) jump();
          break;
        case "JUMPIFEQ":
        case "JUMPIFNOTEQ":
        case "JUMPIFLE":
        case "JUMPIFNOTLE":
        case "JUMPIFLT":
        case "JUMPIFNOTLT": {
          const x = R[A];
          const y = R[aux()];
          const test = name.includes("EQ") ? this.equal(x, y) : name.includes("LE") ? Number(x) <= Number(y) : Number(x) < Number(y);
          if (test !== name.includes("NOT")) jump();
          break;
        }
        case "JUMPXEQKNIL":
        case "JUMPXEQKB":
        case "JUMPXEQKN":
        case "JUMPXEQKS": {
          const x = aux();
          const not = x >>> 31 === 1;
          const v = R[A];
          const test =
            name === "JUMPXEQKNIL" ? v === undefined : name === "JUMPXEQKB" ? v === ((x & 1) === 1) : this.equal(v, k[x & 0xffffff]);
          if (test !== not) jump();
          break;
        }
        case "ADD":
        case "SUB":
        case "MUL":
        case "DIV":
        case "MOD":
        case "POW":
        case "IDIV":
          R[A] = arith(name, R[B], R[C]);
          break;
        case "ADDK":
        case "SUBK":
        case "MULK":
        case "DIVK":
        case "MODK":
        case "POWK":
        case "IDIVK":
          R[A] = arith(name.slice(0, -1), R[B], k[C]);
          break;
        case "SUBRK":
        case "DIVRK":
          R[A] = arith(name.slice(0, 3), k[B], R[C]);
          break;
        case "AND":
          R[A] = truthy(R[B]) ? R[C] : R[B];
          break;
        case "OR":
          R[A] = truthy(R[B]) ? R[B] : R[C];
          break;
        case "ANDK":
          R[A] = truthy(R[B]) ? k[C] : R[B];
          break;
        case "ORK":
          R[A] = truthy(R[B]) ? R[B] : k[C];
          break;
        case "CONCAT":
          R[A] = R.slice(B, C + 1).map(luaText).join("");
          break;
        case "NOT":
          R[A] = !truthy(R[B]);
          break;
        case "MINUS":
          R[A] = -Number(R[B]);
          break;
        case "LENGTH": {
          const v = R[B];
          let n = 0;
          if (typeof v === "string") n = v.length;
          else if (v instanceof LuaTable) while (luaGet(v, n + 1) !== undefined) n++;
          R[A] = n;
          break;
        }
        case "NEWTABLE":
          aux();
          R[A] = new LuaTable();
          break;
        case "DUPTABLE":
          R[A] = new LuaTable();
          break;
        case "SETLIST": {
          const start = aux();
          const n = C ? C - 1 : top - B;
          for (let j = 0; j < n; j++) this.assign(R[A], start + j, R[B + j]);
          break;
        }
        case "FORNPREP": {
          const limit = Number(R[A]);
          const step = Number(R[A + 1]);
          const idx = Number(R[A + 2]);
          if (!(step > 0 ? idx <= limit : limit <= idx)) jump();
          break;
        }
        case "FORNLOOP": {
          const limit = Number(R[A]);
          const step = Number(R[A + 1]);
          const idx = Number(R[A + 2]) + step;
          R[A + 2] = idx;
          if (step > 0 ? idx <= limit : limit <= idx) jump();
          break;
        }
        case "FORGPREP":
        case "FORGPREP_INEXT":
        case "FORGPREP_NEXT":
          if (R[A] instanceof LuaTable) R[A + 2] = 0;
          jump();
          break;
        case "FORGLOOP": {
          const vars = aux() & 255;
          const gen = R[A];
          let res: Value[];
          if (gen instanceof LuaTable) {
            const pos = Number(R[A + 2]);
            const entry = [...gen.map.values()][pos];
            res = entry ? [entry[0], entry[1]] : [];
            R[A + 2] = pos + 1;
          } else {
            res = this.call(gen, [R[A + 1], R[A + 2]]);
            R[A + 2] = res[0];
          }
          for (let j = 0; j < vars; j++) R[A + 3 + j] = res[j];
          if (res[0] !== undefined) jump();
          break;
        }
        case "GETVARARGS": {
          const n = B ? B - 1 : varargs.length;
          for (let j = 0; j < n; j++) R[A + j] = varargs[j];
          if (!B) top = A + n;
          break;
        }
        case "PREPVARARGS":
        case "NOP":
        case "BREAK":
        case "COVERAGE":
          break;
        case "FASTCALL":
        case "FASTCALL1":
        case "FASTCALL2":
        case "FASTCALL2K":
        case "FASTCALL3": {
          const hasAux = name === "FASTCALL2" || name === "FASTCALL2K" || name === "FASTCALL3";
          const x = hasAux ? aux() : 0;
          const callAt = pc + (hasAux ? C - 1 : C);
          const fn = BUILTINS[A];
          const call = code[callAt];
          if (!fn || call === undefined || OP_NAME[call & 255] !== "CALL") break;
          const ca = (call >>> 8) & 255;
          let fargs: Value[];
          if (name === "FASTCALL1") fargs = [R[B]];
          else if (name === "FASTCALL2") fargs = [R[B], R[x]];
          else if (name === "FASTCALL2K") fargs = [R[B], k[x]];
          else if (name === "FASTCALL3") fargs = [R[B], R[x & 255], R[(x >>> 8) & 255]];
          else {
            const cb = (call >>> 16) & 255;
            fargs = R.slice(ca + 1, ca + (cb ? cb : top - ca));
          }
          place(ca, fn(...fargs), (call >>> 24) - 1);
          pc = callAt + 1;
          break;
        }
        default:
          throw new LuaError(`unknown op 0x${(w & 255).toString(16)} in ${chunk.name ?? "?"}#${chunk.protos.indexOf(p)}:${at}`);
      }
    }
  }

  private assign(obj: Value, key: Value, v: Value): void {
    if (obj instanceof LuaTable) luaSet(obj, key, v);
    else if (typeof obj !== "function") throw new LuaError(`cannot assign into ${luaText(obj)}`);
  }

  private isProbe(f: Native): boolean {
    for (const p of this.probes.values()) if (p === f) return true;
    return false;
  }

  private equal(x: Value, y: Value): boolean {
    if (x instanceof Hashed && y instanceof Hashed) return x.h === y.h;
    if (typeof x === "function" && typeof y === "string" && this.isProbe(x)) return this.paramValues.has(y);
    if (typeof y === "function" && typeof x === "string" && this.isProbe(y)) return this.paramValues.has(x);
    return x === y;
  }
}

const SCRIPTS = { toc: "B.Font.toc", cache: "B.Font.cache" };

export class GameScripts {
  private index: Promise<Map<string, TocEntry>> | null = null;
  private readonly chunks = new Map<string, Chunk>();

  constructor(private readonly dir: string) {}

  private entries(): Promise<Map<string, TocEntry>> {
    return (this.index ??= readFile(join(this.dir, SCRIPTS.toc)).then(tocIndex));
  }

  async chunk(path: string): Promise<Chunk | null> {
    const hit = this.chunks.get(path);
    if (hit) return hit;
    const e = (await this.entries()).get(path);
    if (!e) return null;
    const chunk = { ...parseChunk(await readEntry(join(this.dir, SCRIPTS.cache), e)), name: path };
    this.chunks.set(path, chunk);
    for (const s of chunk.strings) if (/^\w+(\.\w+)+$/.test(s) && !s.endsWith(".lua")) await this.chunk(LuaVM.modulePath(s));
    return chunk;
  }

  loaded(): Map<string, Chunk> {
    return this.chunks;
  }
}

export interface LocScript {
  script: string;
  fn: string;
  params: Record<string, string>;
}

export function parseLocScript(def: string, type: string): LocScript | null {
  const block = /^EnhancementTagLocScript=\{\n([\s\S]*?)\n\}$/m.exec(def)?.[1];
  if (!block) return null;
  const kv: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = /^(\w+)=(.*)$/.exec(line);
    if (m) kv[m[1]!] = m[2]!;
  }
  const { Script: script, Function: fn } = kv;
  if (!script || !fn || script === '""') return null;
  const params = Object.fromEntries(Object.entries(kv).filter(([k]) => k.startsWith("_")).map(([k, v]) => [k, v === '""' ? "" : v]));
  return { script: script.startsWith("/") ? script : `${type.slice(0, type.lastIndexOf("/"))}/${script}`, fn, params };
}

const shown = (v: Value): string | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? String(Number(n.toFixed(2))) : null;
};

export interface ScriptSource {
  chunk(path: string): Promise<Chunk | null>;
  loaded(): Map<string, Chunk>;
}

function contextFor(variant: number): LuaTable {
  const t = new LuaTable();
  t.meta = luaTable({ __index: () => [() => [variant]] });
  return t;
}

export async function locValues(scripts: ScriptSource, ls: LocScript, ranks = 4, variant?: number): Promise<Record<string, string[]> | null> {
  if (!(await scripts.chunk(ls.script))) return null;
  const params = new LuaTable();
  for (const [k, v] of Object.entries(ls.params)) luaSet(params, k, v);
  const out: Record<string, string[]> = {};
  try {
    for (let rank = 1; rank <= ranks; rank++) {
      const vm = new LuaVM(scripts.loaded());
      const res = vm.call(luaGet(vm.load(ls.script, params), ls.fn), variant === undefined ? [rank] : [rank, undefined, contextFor(variant)])[0];
      if (!(res instanceof LuaTable)) return null;
      for (const [k, v] of res.map.values()) {
        const text = shown(v);
        if (typeof k !== "string" || text === null) continue;
        (out[k] ??= [])[rank - 1] = text;
      }
    }
  } catch (e) {
    if (e instanceof LuaError) return null;
    throw e;
  }
  for (const [k, v] of Object.entries(out)) if (v.length !== ranks || v.includes(undefined as never)) delete out[k];
  return Object.keys(out).length ? out : null;
}
