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
import { COLLECTOR_TAG, dockedCollector, TimerAlarms, withAgariNames, type GameTimer } from "../src/server/timers";
import { noteDataRefreshed, setImportStatus } from "../src/server/importStatus";
import { startUpdater } from "./updater";
import { apiPausedUntil, noteApiAccepted, noteApiRefused, pausedMessage } from "../src/server/apiBackoff";
import { AVAKOT_VENDOR, avakotDue, avakotDueAt, noteAvakotAttempt, parseVendorInfo, recordAvakot, type AvakotOffer } from "../src/server/avakot";
import { fetchVendorInfo } from "../helper/fetchVendor";
import { EndpointRefusedError } from "../helper/fetchInventory";
import { gameBeingRefused, gameRefusedMessage, loggedCollector, loggedGame, refusalDetails } from "../src/server/gameLog";
import { readDataJson } from "../src/server/paths";
import { findCacheDir } from "../src/gamedata/cache";
import { GameDataWatcher } from "../src/gamedata/watch";
import { Wiki } from "../src/gamedata/wiki";
import { buildTotems, buildTotemData, buildWeapons, buildTempers, buildPactArts, buildMasteryRank } from "../scripts/build_data";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICON_PATH = join(HERE, "public", "img", "icon-256.png");

const USER_DATA = app.getPath("userData");
const CONSENT_PATH = join(USER_DATA, "consent.json");
const CONFIG_PATH = join(USER_DATA, "config.json");
const INVENTORY_PATH = join(USER_DATA, "inventory.json");
const DATA_DIR = join(USER_DATA, "data");
const LOG_PATH = join(USER_DATA, "sfhelper.log");
const PREV_LOG_PATH = join(USER_DATA, "sfhelper.prev.log");
const GAME_DATA_STATE_PATH = join(USER_DATA, "gamedata.json");
const APP_PORT = 47317;
const TITLE_BAR = { color: "#120e0b", symbolColor: "#c9a55c", height: 36 };
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 4;
const ZOOM_REPEAT_MS = 10;

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
    log("Refreshing totem, weapon class, temper and Pact Art data from the wiki…");
    const [t, w, tp, pa, td, mr] = await Promise.all([
      buildTotems(join(DATA_DIR, "totems.json"), undefined, join(HERE, "public", "totems.json")),
      buildWeapons(join(DATA_DIR, "weapons.json")),
      buildTempers(join(DATA_DIR, "tempers.json")),
      buildPactArts(join(DATA_DIR, "pactarts.json")),
      buildTotemData(join(DATA_DIR, "totemdata.json"), undefined, join(HERE, "public", "totemdata.json")),
      buildMasteryRank(join(DATA_DIR, "masteryrank.json")).catch(() => ({ ok: 0 })),
    ]);
    noteDataRefreshed();
    log(`Wiki data updated: ${t.ok} totems, ${w.ok} weapon classes, ${tp.ok} tempers, ${pa.ok} pact arts, ${td.ok} totem cards${mr.ok ? ", max Envoy Rank" : ""}.`);
  } catch (err) {
    log(`Effect data refresh failed (using bundled data): ${(err as Error).message}`);
  }
}

const GAME_DATA_FIRST_MS = 30_000;
const GAME_DATA_CHECK_MS = 10 * 60_000;
const gameData = new GameDataWatcher({
  statePath: GAME_DATA_STATE_PATH,
  outDir: DATA_DIR,
  bundledDir: join(HERE, "public"),
  appVersion: app.getVersion(),
  locate: async () => {
    const logged = await loggedGame();
    return { dir: await findCacheDir(logged?.log ?? null, logged?.cacheDir ?? null), build: logged?.build ?? null };
  },
  wiki: () => new Wiki(),
  log,
  onChanged: () => {
    resetNameCaches();
    noteDataRefreshed();
  },
});

let importing = false;
let session: ImportSession | undefined;
let lastImportOk = 0;
let gameWasRefused = false;
const loggedRefusals = new Set<string>();
async function logRefusalDetails(): Promise<void> {
  for (const d of await refusalDetails().catch(() => [])) {
    const key = `${d.at}|${d.status}|${d.before}`;
    if (loggedRefusals.has(key)) continue;
    loggedRefusals.add(key);
    const from = d.server ? ` from ${d.server}` : " (no Server header)";
    const after = d.after ? `; after it: "${d.after}"` : "";
    log(`Refused at ${new Date(d.at).toLocaleTimeString()}: ${d.status}${from}; before it: "${d.before}"${after}`);
  }
}

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
    await logRefusalDetails();
    setImportStatus({ state: "error", code: 9, message });
    return;
  }
  if (gameWasRefused) {
    await logRefusalDetails();
    log("The game's requests are getting through again; resuming imports.");
  }
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
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
async function scheduleAvakot(): Promise<void> {
  clearTimeout(avakotTimer);
  const due = await avakotDueAt();
  const wait = Number.isFinite(due) ? Math.min(MAX_TIMEOUT_MS, Math.max(0, due - Date.now())) : REIMPORT_INTERVAL_MS;
  avakotTimer = setTimeout(async () => {
    if (importing || Date.now() - lastImportOk > REIMPORT_INTERVAL_MS + 30_000) return;
    if (await gameBeingRefused()) return;
    await refreshAvakot();
  }, wait);
}

let avakotNames: Map<string, string> | null = null;
async function avakotItemName(storeItem: string): Promise<string> {
  if (!avakotNames) {
    const pool = await readDataJson<{ items?: { storeItem: string; name: string }[] }>("avakot.json");
    avakotNames = new Map((pool?.items ?? []).map((i) => [i.storeItem, i.name]));
  }
  return avakotNames.get(storeItem) ?? (await displayName(storeItem.replace("/SF/StoreItems/", "/SF/")));
}

const shownNotifications: Notification[] = [];
const MAX_KEPT_NOTIFICATIONS = 20;
function showNotification(n: Notification, tab: string): void {
  const forget = () => {
    const i = shownNotifications.indexOf(n);
    if (i >= 0) shownNotifications.splice(i, 1);
  };
  n.on("click", () => {
    forget();
    showTab(tab);
  });
  n.on("close", forget);
  n.on("failed", forget);
  shownNotifications.push(n);
  if (shownNotifications.length > MAX_KEPT_NOTIFICATIONS) shownNotifications.shift();
  n.show();
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
  showNotification(n, "avakot");
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
  showNotification(n, "overview");
  log(`Cooldown notification: ${t.tag}.`);
}

const COLLECTOR_NOTIFY_MS = 15 * 60_000;
const COLLECTOR_REPEAT_MS = 60 * 60_000;
let collectorSeen = 0;
async function checkCollector(): Promise<void> {
  const c = await loggedCollector();
  const docked = dockedCollector(c);
  if (!c || !docked || c.at === collectorSeen) return;
  const again = c.at - collectorSeen < COLLECTOR_REPEAT_MS;
  collectorSeen = c.at;
  const where = docked.region ?? "Midrath";
  log(`The Collector docked in ${where}.`);
  if (again || Date.now() - c.at > COLLECTOR_NOTIFY_MS || !Notification.isSupported()) return;
  const settings = await getSettings();
  if (!settings.timerNotify || !settings.timerWatch.includes(COLLECTOR_TAG)) return;
  const until = docked.leaves ? ` · leaves ${new Date(docked.leaves).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
  const n = new Notification({ title: "The Collector is descending!", body: `Hark, The Collector · ${where}${until}`, icon: ICON_PATH, silent: false });
  showNotification(n, "overview");
}

let itemNames: Record<string, string> | null = null;
function resetNameCaches(): void {
  avakotNames = null;
  itemNames = null;
}

async function displayName(itemType: string): Promise<string> {
  if (!itemNames) itemNames = (await readDataJson<{ items?: Record<string, string> }>("names.json"))?.items ?? {};
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
  showNotification(n, "pickups");
  log(`Moonsteel ${name} acquired (${p.source ?? "pickup"}).`);
}

function watchZoom(wc: Electron.WebContents): void {
  let lastZoomAt = -Infinity;
  wc.on("zoom-changed", (_e, direction) => {
    const now = performance.now();
    if (now - lastZoomAt < ZOOM_REPEAT_MS) return;
    lastZoomAt = now;
    const level = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, wc.getZoomLevel() + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP)));
    wc.setZoomLevel(level);
  });
}

function createMainWindow(url: string): void {
  const area = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1560, area.width),
    height: Math.min(980, area.height),
    backgroundColor: "#14110f",
    title: "SFHelper",
    icon: ICON_PATH,
    titleBarStyle: "hidden",
    titleBarOverlay: TITLE_BAR,
    webPreferences: { contextIsolation: true },
  });
  void mainWindow.loadURL(url);
  watchZoom(mainWindow.webContents);
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("https://github.com/hunhow0x1/SFHelper")) void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, target) => {
    if (!target.startsWith(url)) e.preventDefault();
  });
  mainWindow.on("closed", () => (mainWindow = null));
}

async function proceed(): Promise<void> {
  process.env.SFHELPER_HOME = USER_DATA;
  process.env.SFHELPER_DATA_DIR = DATA_DIR;
  process.env.SFHELPER_INVENTORY = INVENTORY_PATH;

  onMoonsteelAcquired((p) => void notifyMoonsteel(p));
  server = await startServer(APP_PORT).catch(() => startServer(0));
  createMainWindow(server.url);

  void refreshData();
  startUpdater(log);
  void armSavedTimers();
  setInterval(() => {
    for (const t of timerAlarms.due()) void notifyTimer(t);
    void checkCollector().catch(() => {});
  }, TIMER_CHECK_MS);
  void importFromMemory();
  setInterval(() => void importFromMemory(), REIMPORT_INTERVAL_MS);
  setTimeout(() => void gameData.check(), GAME_DATA_FIRST_MS);
  setInterval(() => void gameData.check(), GAME_DATA_CHECK_MS);
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
    win.removeMenu();
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
