import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server/server";
import { onUpdateAction, setUpdateStatus, type UpdateAction } from "../src/server/updateStatus";

describe("update endpoints", () => {
  let server: RunningServer;
  const post = (body: unknown, type = "application/json") =>
    fetch(`${server.url}/api/update`, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });

  beforeAll(async () => {
    server = await startServer(0);
  });
  afterAll(() => server.close());

  it("reports nothing and refuses actions outside the desktop app", async () => {
    expect(await (await fetch(`${server.url}/api/update`)).json()).toBeNull();
    expect((await post({ action: "check" })).status).toBe(409);
  });

  it("passes the page's buttons to the app, JSON only", async () => {
    const actions: UpdateAction[] = [];
    onUpdateAction((a) => actions.push(a));
    setUpdateStatus({ current: "0.2.0", state: "ready", version: "0.2.1" });

    expect(await (await fetch(`${server.url}/api/update`)).json()).toMatchObject({ state: "ready", version: "0.2.1" });
    expect((await post({ action: "install" })).status).toBe(200);
    // A form post from another site can't set a JSON content type.
    expect((await post({ action: "install" }, "text/plain")).status).toBe(415);
    expect((await post({ action: "uninstall" })).status).toBe(400);
    expect(actions).toEqual(["install"]);
  });
});
