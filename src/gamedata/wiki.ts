const API = "https://wiki.avakot.org/w/api.php";
const UA = "SFHelper/0.0 (+https://github.com/hunhow0x1/SFHelper)";
const GAP_MS = 150;

export class Wiki {
  private next = 0;
  private readonly pages = new Map<string, Promise<string | null>>();

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  private async get(url: string): Promise<Response> {
    const wait = this.next - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await this.fetchFn(url, { headers: { "user-agent": UA } });
    } finally {
      this.next = Date.now() + GAP_MS;
    }
  }

  private async api(params: Record<string, string>): Promise<any> {
    const res = await this.get(`${API}?${new URLSearchParams({ format: "json", ...params })}`);
    if (!res.ok) throw new Error(`wiki ${res.status}`);
    return res.json();
  }

  wikitext(page: string): Promise<string | null> {
    let p = this.pages.get(page);
    if (!p) {
      p = this.api({ action: "parse", page, prop: "wikitext" })
        .then((r) => (typeof r?.parse?.wikitext?.["*"] === "string" ? (r.parse.wikitext["*"] as string) : null))
        .catch(() => null);
      this.pages.set(page, p);
    }
    return p;
  }

  async image(file: string): Promise<Buffer | null> {
    try {
      const q = await this.api({ action: "query", prop: "imageinfo", iiprop: "url", titles: `File:${file}` });
      const src = (Object.values(q?.query?.pages ?? {})[0] as { imageinfo?: { url?: string }[] } | undefined)?.imageinfo?.[0]?.url;
      if (!src) return null;
      const res = await this.get(src);
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }
}
