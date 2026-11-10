import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gameBeingRefused, gameRefusals, refusalDetails } from "../src/server/gameLog";

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
      last: START + 7278398,
      loginRefused: false,
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

  it("keeps what each refusal was about: status, server, and the game's lines around it", async () => {
    expect(await refusalDetails(await logFile(LOG))).toEqual([
      {
        at: Date.parse("Mon, 26 Oct 2026 21:06:09 GMT"),
        status: "403 Forbidden",
        server: "AkamaiGHost",
        before: "CheckEntitlements started!",
        after: "Could not get credits:",
      },
      { at: Date.parse("Mon, 26 Oct 2026 21:46:24 GMT"), status: "429 Too Many Requests", server: null, before: "HTTP/1.1 200 OK", after: null },
      {
        at: START + 7278398,
        status: "403 Forbidden",
        server: "AkamaiGHost",
        before: "HTTP/1.1 429 Too Many Requests",
        after: "Failed to commit challenge progress to DB. Retrying (#356) in 10",
      },
    ]);
  });
});

const LOGIN = `0.050 Sys [Diag]: Current time: Mon Nov  9 23:09:52 2026 [UTC: Tue Nov 10 04:09:52 2026]
34.924 Script [Info]: MainMenu.lua: DispatchLogin()
34.924 Sys [Info]: Logging in as someone@example.com
35.071 Sys [Warning]: HTTP/1.1 403 Forbidden
35.071 Sys [Warning]: Content-Length: 0
35.071 Sys [Warning]: Date: Tue, 10 Nov 2026 04:10:27 GMT
35.071 Sys [Warning]: Server: AkamaiGHost
35.073 Sys [Error]: Login failed: 
35.073 Script [Info]: MainMenu.lua: MainMenu::LoginDone result=false
`;

const LOGGED_IN = `90.000 Sys [Info]: Logging in as someone@example.com
90.400 Sys [Info]: Logged in Unix
91.000 Script [Info]: MainMenu.lua: MainMenu::LoginDone result=true
`;

describe("a login refused by Akamai", () => {
  const HOUR = 3600_000;
  const REFUSED_AT = Date.parse("Tue, 10 Nov 2026 04:10:27 GMT");

  it("keeps SFHelper waiting until the game logs in, not just for 5 minutes", async () => {
    const path = await logFile(LOGIN);
    expect(await gameBeingRefused(REFUSED_AT + 3 * HOUR, path)).toEqual({ count: 1, first: REFUSED_AT, last: REFUSED_AT, loginRefused: true });
    await appendFile(path, LOGGED_IN);
    expect(await gameBeingRefused(REFUSED_AT + 10 * 60_000, path)).toBeNull();
  });

  it("still holds after the game is restarted, until the new session logs in", async () => {
    const path = await logFile(LOGIN);
    expect(await gameBeingRefused(REFUSED_AT + HOUR, path)).not.toBeNull();
    await writeFile(path, "0.050 Sys [Diag]: Current time: Mon Nov  9 23:40:00 2026 [UTC: Tue Nov 10 04:40:00 2026]\n5.000 Sys [Info]: Main menu\n");
    expect(await gameBeingRefused(REFUSED_AT + HOUR, path)).toMatchObject({ first: REFUSED_AT, loginRefused: true });
    await appendFile(path, LOGGED_IN);
    expect(await gameBeingRefused(REFUSED_AT + HOUR, path)).toBeNull();
  });

  it("only counts Akamai's refusals, so a failed login for another reason isn't taken for a block", async () => {
    const path = await logFile(LOGIN.replace("Server: AkamaiGHost", "Server: nginx"));
    expect(await gameRefusals(path)).toMatchObject({ count: 1, loginRefused: false });
    expect(await gameBeingRefused(REFUSED_AT + 10 * 60_000, path)).toBeNull();
  });
});
