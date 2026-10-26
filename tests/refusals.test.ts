import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gameBeingRefused, gameRefusals } from "../src/server/gameLog";

// Shaped like the real EE.log from 2026-10-26, when Akamai refused every request.
const LOG = `0.040 Sys [Diag]: Build Label: 2026.10.08.15.20 Retail Windows x64 [Stripped]
0.041 Sys [Diag]: Current time: Mon Oct 26 16:06:24 2026 [UTC: Mon Oct 26 20:06:24 2026]
3467.756 Net [Info]: Updating session (heartbeat)
3584.522 Sys [Info]: CheckEntitlements started!
3584.972 Sys [Warning]: HTTP/1.1 403 Forbidden
3584.972 Sys [Warning]: Content-Type: text/html
3584.972 Sys [Warning]: Content-Length: 0
3584.972 Sys [Warning]: Date: Mon, 26 Oct 2026 21:06:09 GMT
3584.972 Sys [Warning]: Server: AkamaiGHost
3584.984 Sys [Error]: Could not get credits:
3590.000 Sys [Info]: HTTP/1.1 200 OK
6000.000 Sys [Warning]: HTTP/1.1 429 Too Many Requests
6000.000 Sys [Warning]: Date: Mon, 26 Oct 2026 21:46:24 GMT
7278.398 Sys [Warning]: HTTP/1.1 403 Forbidden
7278.398 Sys [Warning]: Server: AkamaiGHost
7278.403 Sys [Error]: Failed to commit challenge progress to DB. Retrying (#356) in 10
`;

async function logFile(text: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "sfh-eelog-")), "EE.log");
  await writeFile(path, text);
  return path;
}

describe("the game being refused by DE's servers", () => {
  const START = Date.UTC(2026, 9, 26, 20, 6, 24);

  it("counts 403s and 429s, timed by the server's Date header or else the log clock", async () => {
    const r = await gameRefusals(await logFile(LOG));
    expect(r).toEqual({
      count: 3,
      first: Date.parse("Mon, 26 Oct 2026 21:06:09 GMT"),
      last: START + 7278398, // no Date header: log time
    });
  });

  it("is only 'still refused' while refusals keep coming", async () => {
    const path = await logFile(LOG);
    const last = START + 7278398;
    expect(await gameBeingRefused(last + 60_000, path)).not.toBeNull();
    expect(await gameBeingRefused(last + 10 * 60_000, path)).toBeNull();
  });

  it("finds nothing in a normal log", async () => {
    const path = await logFile(LOG.split("\n").filter((l) => !/HTTP\/1\.1 4/.test(l)).join("\n"));
    expect(await gameRefusals(path)).toBeNull();
    expect(await gameBeingRefused(START, path)).toBeNull();
  });
});
