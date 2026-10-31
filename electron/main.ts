import { app, BrowserWindow, ipcMain, Notification, screen, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readConsent, recordConsent, ACK_PHRASE } from "../helper/consent";
import { importInventory, type ImportSession } from "../helper/run";
import { recordHistory, startServer, type RunningServer } from "../src/server/server";
import { onMoonsteelAcquired, type Pickup } from "../src/server/pickups";
import { getSettings } from "../src/server/settings";
import { getInventory } from "../src/server/inventory";
import { TimerAlarms, withAgariNames, type GameTimer } from "../src/server/timers";
import { setImportStatus } from "../src/server/importStatus";
import { startUpdater } from "./updater";
import { apiPausedUntil, noteApiAccepted, noteApiRefused, pausedMessage } from "../src/server/apiBackoff";
import { AVAKOT_VENDOR, avakotDue, avakotDueAt, noteAvakotAttempt, parseVendorInfo, recordAvakot, type AvakotOffer } from "../src/server/avakot";
import { fetchVendorInfo } from "../helper/fetchVendor";
import { EndpointRefusedError } from "../helper/fetchInventory";
import { gameBeingRefused, gameRefusedMessage } from "../src/server/gameLog";
import { buildTotems, buildTotemData, buildRunes, buildWeapons, buildPacts, buildTempers, buildPactArts, buildTalismans, buildArmour, buildMasteryRank } from "../scripts/build_data";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON_PATH = join(HERE, "public", "img", "icon-256.png");

const USER_DATA = app.getPath("userData");
const CONSENT_PATH = join(USER_DATA, "consent.json");
const CONFIG_PATH = join(USER_DATA, "config.json");
const INVENTORY_PATH = join(USER_DATA, "inventory.json");
const DATA_DIR = join(USER_DATA, "data");
const LOG_PATH = join(USER_DATA, "sfhelper.log");
const PREV_LOG_PATH = join(USER_DATA, "sfhelper.prev.log");

let server: RunningServer | null = null;
let mainWindow: BrowserWindow | null = null;

let logReady: Promise<void> | null = null;
function log(msg: string): void {
  console.log(`[sfhelper] ${msg}`);
  logReady ??= mkdir(USER_DATA, { recursive: true })
    .then(() => rename(LOG_PATH, PREV_LOG_PATH).catch(() => {}))
    .then(() => writeFile(LOG_PATH, `SFHelper ${app.getVersion()} on ${process.platform} ${process.arch}\n`))
    .catch(() => {});
  logReady = logReady.then(() => appendFile(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)).catch(() => {});
}

async function refreshData(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    log("Refreshing totem/rune/weapon/pact/temper/pact-art data…");
    const [t, r, w, p, tp, pa, td, tl, ar, mr] = await Promise.all([
      buildTotems(join(DATA_DIR, "totems.json")),
      buildRunes(join(DATA_DIR, "runes.json")),
      buildWeapons(join(DATA_DIR, "weapons.json")),
      buildPacts(join(DATA_DIR, "pacts.json")),
      buildTempers(join(DATA_DIR, "tempers.json")),
      buildPactArts(join(DATA_DIR, "pactarts.json")),
      buildTotemData(join(DATA_DIR, "totemdata.json")),
      buildTalismans(join(DATA_DIR, "talismans.json")),
      buildArmour(join(DATA_DIR, "armour.json")).catch(() => ({ ok: 0 })),
      buildMasteryRank(join(DATA_DIR, "masteryrank.json")).catch(() => ({ ok: 0 })),
    ]);
    log(`Data updated: ${t.ok} totems, ${r.ok} runes, ${w.ok} weapons, ${p.ok} pacts, ${tp.ok} tempers, ${pa.ok} pact arts, ${td.ok} totem cards, ${tl.ok} talismans, ${ar.ok} armour pieces${mr.ok ? ", max Envoy Rank" : ""}.`);
  } catch (err) {
    log(`Effect data refresh failed (using bundled data): ${(err as Error).message}`);
  }
}

let importing = false;
let session: ImportSession | undefined;
let lastImportOk = 0;
let gameWasRefused = false;
async function importFromMemory(): Promise<void> {
  if (importing) return;
  const paused = apiPausedUntil();
  if (paused) {
    setImportStatus({ state: "error", code: 8, message: pausedMessage(paused) });
    return;
  }
  const refused = await gameBeingRefused();
  if (refused) {
    const message = gameRefusedMessage(refused);
    if (!gameWasRefused) log(`Holding off: ${message} (${refused.count} refusals in the game log so far.)`);
    gameWasRefused = true;
    setImportStatus({ state: "error", code: 9, message });
    return;
  }
  if (gameWasRefused) log("The game's requests are getting through again; resuming imports.");
  gameWasRefused = false;
  importing = true;
  setImportStatus({ state: "scanning", message: "Looking for Soulframe…" });
  try {
    const result = await importInventory({
      out: INVENTORY_PATH,
      configPath: CONFIG_PATH,
      consentPath: CONSENT_PATH,
      session,
      onLog: (m) => log(m),
      onProgress: (label, pct) => {
        log(`${label}: ${pct}%`);
        setImportStatus({ state: "scanning", message: `Reading game memory for the ${label}… ${pct}%` });
      },
    });
    if (result.ok) {
      noteApiAccepted();
      lastImportOk = Date.now();
    }
    if (result.ok) session = result.session;
    else if (result.code !== 8) session = undefined;
    const message = result.code === 8 ? pausedMessage(noteApiRefused()) : result.message;
    log(result.ok ? result.message : `Inventory import skipped (${result.code}): ${result.message}`);
    if (result.ok) {
      try {
        const inventory = await getInventory();
        await recordHistory(inventory);
        timerAlarms.set(await withAgariNames(inventory?.timers ?? []));
      } catch (err) {
        log(`Recording pickups/trades failed: ${(err as Error).message}`);
      }
    }
    setImportStatus(
      result.ok
        ? { state: "ok", message: "Inventory imported." }
        : { state: "error", code: result.code, message },
    );
    if (result.ok) void refreshAvakot();
  } catch (err) {
    log(`Inventory import failed: ${(err as Error).stack ?? String(err)}`);
    setImportStatus({ state: "error", message: `Import failed: ${(err as Error).message}` });
  } finally {
    importing = false;
  }
}

const REIMPORT_INTERVAL_MS = 120_000;

let avakotBusy = false;
async function refreshAvakot(): Promise<void> {
  const s = session;
  if (!s || avakotBusy || apiPausedUntil()) return;
  if (!(await avakotDue())) return scheduleAvakot();
  avakotBusy = true;
  try {
    await noteAvakotAttempt();
    const stock = parseVendorInfo(await fetchVendorInfo(s.accountId, s.nonce, AVAKOT_VENDOR));
    noteApiAccepted();
    const settings = await getSettings();
    const fresh = await recordAvakot(stock, settings.avakotWatch);
    const rotating = stock.offers.filter((o) => o.expiry !== null).length;
    log(`Avakot's stock updated: ${rotating} rotating offers, next change at ${new Date(stock.nextChange).toLocaleTimeString()}.`);
    if (fresh.length && settings.avakotNotify) await notifyAvakot(fresh);
  } catch (err) {
    if (err instanceof EndpointRefusedError) log(`Avakot's stock: ${pausedMessage(noteApiRefused(), err.status)}`);
    else log(`Avakot's stock check failed: ${(err as Error).message}`);
  } finally {
    avakotBusy = false;
  }
  await scheduleAvakot();
}

let avakotTimer: ReturnType<typeof setTimeout> | undefined;
async function scheduleAvakot(): Promise<void> {
  clearTimeout(avakotTimer);
  const wait = Math.max(0, (await avakotDueAt()) - Date.now());
  avakotTimer = setTimeout(async () => {
    if (importing || Date.now() - lastImportOk > REIMPORT_INTERVAL_MS + 30_000) return;
    if (await gameBeingRefused()) return;
    await refreshAvakot();
  }, wait);
}

let avakotNames: Map<string, string> | null = null;
async function avakotItemName(storeItem: string): Promise<string> {
  if (!avakotNames) {
    try {
      const pool = JSON.parse(await readFile(join(HERE, "public", "avakot.json"), "utf8")) as { items?: { storeItem: string; name: string }[] };
      avakotNames = new Map((pool.items ?? []).map((i) => [i.storeItem, i.name]));
    } catch {
      avakotNames = new Map();
    }
  }
  return avakotNames.get(storeItem) ?? (await displayName(storeItem.replace("/SF/StoreItems/", "/SF/")));
}

function showTab(tab: string): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  void mainWindow.webContents.executeJavaScript(`typeof activateTab === "function" && activateTab(${JSON.stringify(tab)})`);
}

async function notifyAvakot(offers: AvakotOffer[]): Promise<void> {
  if (!Notification.isSupported()) return;
  const names = await Promise.all(offers.map((o) => avakotItemName(o.storeItem)));
  const until = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
  const lines = offers.map((o, i) =>
    [names[i], o.price ? `${o.price.toLocaleString()} ${o.currency}` : "", o.expiry ? `until ${until(o.expiry)}` : ""].filter(Boolean).join(" · "),
  );
  const n = new Notification({
    title: offers.length === 1 ? `Avakot has ${names[0]}!` : `Avakot has ${offers.length} of your starred items!`,
    body: lines.join("\n"),
    icon: ICON_PATH,
    silent: false,
  });
  n.on("click", () => showTab("avakot"));
  n.show();
  log(`Avakot notification: ${names.join(", ")}.`);
}

const timerAlarms = new TimerAlarms();
const TIMER_CHECK_MS = 10_000;
async function armSavedTimers(): Promise<void> {
  try {
    timerAlarms.set(await withAgariNames((await getInventory())?.timers ?? []));
  } catch (err) {
    log(`Setting cooldown alarms failed: ${(err as Error).message}`);
  }
}

async function notifyTimer(t: GameTimer): Promise<void> {
  if (!Notification.isSupported()) return;
  const settings = await getSettings();
  if (!settings.timerNotify || !settings.timerWatch.includes(t.tag)) return;
  const n = new Notification({
    title: t.ready,
    body: t.kind ? `${t.name} · ${t.kind}` : "A cooldown in Soulframe has ended.",
    icon: ICON_PATH,
    silent: false,
  });
  n.on("click", () => showTab("overview"));
  n.show();
  log(`Cooldown notification: ${t.tag}.`);
}

let itemNames: Record<string, string> | null = null;
async function displayName(itemType: string): Promise<string> {
  if (!itemNames) {
    try {
      itemNames = (JSON.parse(await readFile(join(HERE, "public", "names.json"), "utf8")) as { items?: Record<string, string> }).items ?? {};
    } catch {
      itemNames = {};
    }
  }
  const leaf = itemType.split("/").pop() ?? itemType;
  return itemNames[itemType] ?? itemNames[leaf] ??
    leaf.replace(/(RangedMeleeWeapon|MeleeWeapon|RangedWeapon|Weapon)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

const CRAFTWORK_NAME: Record<string, string> = {
  IQ_WORN: "Stock", IQ_MILITARY: "Military", IQ_OFFICER: "Officer",
  IQ_NOBLE: "Noble", IQ_MASTERWORK: "Sovereign", IQ_LEGENDARY: "Legendary",
};

async function notifyMoonsteel(p: Pickup): Promise<void> {
  if (!Notification.isSupported()) return;
  if (!(await getSettings()).moonsteelNotify) return;
  const name = await displayName(p.key);
  const craft = (p.craftwork && CRAFTWORK_NAME[p.craftwork]) || "";
  const how = p.source === "crafted" ? "crafted" : p.source === "purchased" ? "bought" : "picked up";
  const n = new Notification({
    title: `✦ Moonsteel ${name}!`,
    body: `You ${how} a Moonsteel ${name}${craft ? ` (${craft})` : ""}.`,
    icon: ICON_PATH,
    silent: false,
  });
  n.on("click", () => showTab("pickups"));
  n.show();
  log(`Moonsteel ${name} acquired (${p.source ?? "pickup"}).`);
}

function createMainWindow(url: string): void {
  const area = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1560, area.width),
    height: Math.min(980, area.height),
    backgroundColor: "#14110f",
    title: "SFHelper",
    icon: ICON_PATH,
    webPreferences: { contextIsolation: true },
  });
  void mainWindow.loadURL(url);
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("https://github.com/hunhow0x1/SFHelper")) void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => (mainWindow = null));
}

async function proceed(): Promise<void> {
  process.env.SFHELPER_HOME = USER_DATA;
  process.env.SFHELPER_DATA_DIR = DATA_DIR;
  process.env.SFHELPER_INVENTORY = INVENTORY_PATH;

  onMoonsteelAcquired((p) => void notifyMoonsteel(p));
  server = await startServer(0);
  createMainWindow(server.url);

  void refreshData();
  startUpdater(log);
  void armSavedTimers();
  setInterval(() => {
    for (const t of timerAlarms.due()) void notifyTimer(t);
  }, TIMER_CHECK_MS);
  void importFromMemory();
  setInterval(() => void importFromMemory(), REIMPORT_INTERVAL_MS);
}

function askConsent(): Promise<boolean> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640,
      height: 580,
      resizable: false,
      backgroundColor: "#14110f",
      title: "SFHelper — before you begin",
      icon: ICON_PATH,
      webPreferences: { contextIsolation: true, preload: join(HERE, "preload.cjs") },
    });
    void win.loadFile(join(HERE, "consent.html"));

    let decided = false;
    ipcMain.once("consent:accept", async () => {
      decided = true;
      await recordConsent(CONSENT_PATH, ACK_PHRASE);
      win.close();
      resolve(true);
    });
    ipcMain.once("consent:decline", () => {
      decided = true;
      win.close();
      resolve(false);
    });
    win.on("closed", () => {
      if (!decided) resolve(false);
    });
  });
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function boot(): Promise<void> {
  if (process.platform === "win32") app.setAppUserModelId("com.hunhow0x1.sfhelper");
  await app.whenReady();
  log(`Starting (data folder: ${USER_DATA})`);
  const consent = await readConsent(CONSENT_PATH);
  if (!consent?.acknowledged) {
    const agreed = await askConsent();
    if (!agreed) {
      app.quit();
      return;
    }
  }
  await proceed();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot().catch((err) => {
    console.error(err);
    log(`Startup failed: ${(err as Error).stack ?? String(err)}`);
    app.quit();
  });
}

app.on("before-quit", () => {
  void server?.close();
});
