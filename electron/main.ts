import { app, BrowserWindow, ipcMain, Notification, screen, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readConsent, recordConsent, ACK_PHRASE } from "../helper/consent";
import { importInventory, type ImportSession } from "../helper/run";
import { recordHistory, startServer, type RunningServer } from "../src/server/server";
import { onMoonsteelAcquired, type Pickup } from "../src/server/pickups";
import { getSettings, onSettingsChange, type Settings } from "../src/server/settings";
import { getInventory, type InventoryView } from "../src/server/inventory";
import { newStarredTotems, totemNamer, type OwnedTotem } from "../src/server/totems";
import { blessedMeetingNear, COLLECTOR_TAG, dockedCollector, TimerAlarms, withAgariNames, type GameTimer } from "../src/server/timers";
import { craftTimers, newlyReady, readyRecipes, recipeTimes, recipeVerb } from "../src/server/recipes";
import type { CraftDef, RecipeDef } from "../src/gamedata/builders";
import { noteDataRefreshed, setImportStatus } from "../src/server/importStatus";
import { startUpdater } from "./updater";
import { apiPausedUntil, liftPauseAfterLogin, noteApiAccepted, noteApiRefused, pausedMessage, restoreApiBackoff } from "../src/server/apiBackoff";
import { AVAKOT_VENDOR, getAvakot, nextAvakotCheck, noteAvakotAttempt, parseVendorInfo, recordAvakot, stockReset, type AvakotCheck, type AvakotOffer, type AvakotStock } from "../src/server/avakot";
import { fetchVendorInfo } from "../helper/fetchVendor";
import { EndpointRefusedError } from "../helper/fetchInventory";
import { gameBeingRefused, gameLoggedInAt, gameRefusals, partyAround, gameRefusedMessage, loggedBlessed, loggedCollector, loggedGame, refusalDetails, type GameRefusals } from "../src/server/gameLog";
import { alreadyReported, recordRefusalEnd, recordRefusalStart } from "../src/server/refusalReport";
import { pruneRequests, readRequests } from "../src/server/requestLog";
import { findSoulframe } from "../helper/processFinder";
import { readDataJson } from "../src/server/paths";
import { setAppVersion } from "../src/server/userAgent";
import { findCacheDir } from "../src/gamedata/cache";
import { GameDataWatcher } from "../src/gamedata/watch";
import { Wiki } from "../src/gamedata/wiki";
import { buildWeapons, buildPactArts } from "../scripts/build_data";

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
setAppVersion(app.getVersion());
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
    log("Refreshing weapon class and Pact Art data from the wiki…");
    const [w, pa] = await Promise.all([
      buildWeapons(join(DATA_DIR, "weapons.json")),
      buildPactArts(join(DATA_DIR, "pactarts.json")),
    ]);
    noteDataRefreshed();
    log(`Wiki data updated: ${w.ok} weapon classes, ${pa.ok} pact arts.`);
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
const STARTED_AT = Date.now();
const BACKOFF_HISTORY_MS = 24 * 3600_000;
const PARTY_WINDOW_MS = 2 * 3600_000;
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

async function gameRunning(): Promise<boolean> {
  return (await findSoulframe().catch(() => [])).length > 0;
}

async function reportRefusalStart(r: GameRefusals): Promise<void> {
  try {
    if (await alreadyReported(r.first)) return;
    const game = await loggedGame();
    await recordRefusalStart({
      refusals: r,
      details: await refusalDetails(),
      publicAddress: game?.publicAddress ?? null,
      build: game?.build ?? null,
      appVersion: app.getVersion(),
      gameRunning: await gameRunning(),
      late: r.first < STARTED_AT,
      party: await partyAround(r.first, PARTY_WINDOW_MS).catch(() => null),
    });
    log("Saved a report on the refusals to refusals.log in the data folder.");
  } catch (err) {
    log(`Couldn't save the refusal report: ${(err as Error).message}`);
  }
}

async function reportEarlierRefusals(): Promise<void> {
  const r = await gameRefusals().catch(() => null);
  if (r && r.count > 0 && !(await gameBeingRefused())) await reportRefusalStart(r);
}

const WAIT_FOR_GAME_MS = 15_000;
const WAIT_FOR_LOGIN_MS = 30_000;
let lastImportCode: number | null = null;
let importTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleImport(): void {
  clearTimeout(importTimer);
  const wait = lastImportCode === 3 ? WAIT_FOR_GAME_MS : lastImportCode === 6 ? WAIT_FOR_LOGIN_MS : REIMPORT_INTERVAL_MS;
  importTimer = setTimeout(() => void importFromMemory().finally(scheduleImport), wait);
}

async function importFromMemory(): Promise<void> {
  if (importing) return;
  if (liftPauseAfterLogin(await gameLoggedInAt().catch(() => null))) {
    log("The game logged in after Soulframe last refused SFHelper, so SFHelper stops waiting.");
  }
  const paused = apiPausedUntil();
  if (paused) {
    lastImportCode = 8;
    setImportStatus({ state: "error", code: 8, message: pausedMessage(paused) });
    return;
  }
  const refused = await gameBeingRefused();
  if (refused) {
    const message = gameRefusedMessage(refused);
    if (!gameWasRefused) {
      log(`Holding off: ${message} (${refused.count} refusals in the game log so far.)`);
      await reportRefusalStart(refused);
    }
    gameWasRefused = true;
    lastImportCode = 9;
    await logRefusalDetails();
    setImportStatus({ state: "error", code: 9, message });
    return;
  }
  if (gameWasRefused) {
    await logRefusalDetails();
    log("The game's requests are getting through again; resuming imports.");
    const ended = await gameRefusals().catch(() => null);
    if (ended) await recordRefusalEnd(ended, await gameRunning()).catch(() => {});
  }
  gameWasRefused = false;
  importing = true;
  if (lastImportCode !== 3) setImportStatus({ state: "scanning", message: "Looking for Soulframe…" });
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
    if (result.ok) noteApiAccepted();
    if (result.code === 3 && lastImportCode !== 3) log("Waiting for Soulframe to start.");
    lastImportCode = result.code;
    if (result.ok) session = result.session;
    else if (result.code !== 8) session = undefined;
    const message = result.code === 8 ? pausedMessage(noteApiRefused()) : result.message;
    if (result.code !== 3) log(result.ok ? result.message : `Inventory import skipped (${result.code}): ${result.message}`);
    if (result.ok) {
      try {
        const inventory = await getInventory();
        await recordHistory(inventory);
        timerAlarms.set(await withAgariNames(inventory?.timers ?? []));
        await armCrafts(inventory);
        await checkRecipes(inventory);
        await checkTotems(inventory);
      } catch (err) {
        log(`Recording pickups/trades failed: ${(err as Error).message}`);
      }
    }
    setImportStatus(
      result.ok
        ? { state: "ok", message: "Inventory imported." }
        : { state: "error", code: result.code, message },
    );
    if (result.ok) void planAvakot();
  } catch (err) {
    lastImportCode = null;
    log(`Inventory import failed: ${(err as Error).stack ?? String(err)}`);
    setImportStatus({ state: "error", message: `Import failed: ${(err as Error).message}` });
  } finally {
    importing = false;
  }
}

const REIMPORT_INTERVAL_MS = 120_000;
const AVAKOT_AFTER_IMPORT_MS = 60_000;

let avakotTimer: ReturnType<typeof setTimeout> | undefined;
async function planAvakot(): Promise<void> {
  const check = await nextAvakotCheck();
  if (check.at > Date.now() + AVAKOT_AFTER_IMPORT_MS) return;
  clearTimeout(avakotTimer);
  avakotTimer = setTimeout(() => void checkAvakot(check), AVAKOT_AFTER_IMPORT_MS);
}

let avakotBusy = false;
async function checkAvakot(check: AvakotCheck): Promise<void> {
  const s = session;
  if (!s || avakotBusy || importing || apiPausedUntil()) return;
  if (await gameBeingRefused()) return;
  if (!(await gameRunning())) return;
  avakotBusy = true;
  try {
    await noteAvakotAttempt(check);
    const stock = parseVendorInfo(await fetchVendorInfo(s.accountId, s.nonce, AVAKOT_VENDOR));
    noteApiAccepted();
    const settings = await getSettings();
    const prev = (await getAvakot()).stock;
    const fresh = await recordAvakot(stock, settings.avakotWatch);
    const rotated = stock.nextChange > stock.fetchedAt;
    const rotating = stock.offers.filter((o) => o.expiry !== null).length;
    const next = new Date((await nextAvakotCheck()).at).toLocaleTimeString();
    log(rotated
      ? `Avakot's stock updated: ${rotating} rotating offers. Next check around ${next}.`
      : check.retry
        ? `Avakot's stock still hadn't changed. Next check around ${next}.`
        : `Avakot's stock came back before his rotation; asking once more around ${next}.`);
    if (rotated && settings.avakotResetNotify && stockReset(prev, stock)) notifyAvakotReset(stock);
    if (fresh.length && settings.avakotNotify) await notifyAvakot(fresh);
  } catch (err) {
    if (err instanceof EndpointRefusedError) log(`Avakot's stock: ${pausedMessage(noteApiRefused(), err.status)}`);
    else log(`Avakot's stock check failed: ${(err as Error).message}`);
  } finally {
    avakotBusy = false;
  }
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

function notifyAvakotReset(stock: AvakotStock): void {
  if (!Notification.isSupported()) return;
  const rotating = stock.offers.filter((o) => o.expiry !== null).length;
  const until = new Date(stock.nextChange).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const n = new Notification({ title: "Avakot's Gots have new stock", body: `${rotating} offers · the next change is at ${until}`, icon: ICON_PATH, silent: false });
  showNotification(n, "avakot");
  log("Avakot new stock notification.");
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
const craftAlarms = new TimerAlarms();
const TIMER_CHECK_MS = 10_000;

async function armCrafts(inv: InventoryView | null): Promise<void> {
  const data = await readDataJson<{ recipes?: Record<string, RecipeDef>; otherCrafts?: Record<string, CraftDef> }>("recipes.json");
  craftAlarms.set(craftTimers(inv?.crafting.pending ?? [], { ...data?.otherCrafts, ...data?.recipes }));
}

async function notifyCrafts(ready: GameTimer[]): Promise<void> {
  log(`Ready to claim: ${ready.map((t) => t.name).join(", ")}.`);
  if (!Notification.isSupported() || !(await getSettings()).forgeNotify) return;
  const n = new Notification({
    title: ready.length === 1 ? ready[0]!.ready : `${ready.length} of your crafts are ready to claim`,
    body: ready.map((t) => (t.kind ? `${t.name} · ${t.kind}` : t.name)).join("\n"),
    icon: ICON_PATH,
    silent: false,
  });
  showNotification(n, "forge");
}

async function armSavedTimers(): Promise<void> {
  try {
    const inventory = await getInventory();
    timerAlarms.set(await withAgariNames(inventory?.timers ?? []));
    await armCrafts(inventory);
    await checkRecipes(inventory);
    totemsBefore = inventory?.totems ?? null;
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

let blessedSeen = 0;
async function checkBlessed(): Promise<void> {
  const b = await loggedBlessed();
  if (!b || b.at === blessedSeen || !blessedMeetingNear(b)) return;
  blessedSeen = b.at;
  const who = b.ancestor ? (await displayName(b.ancestor)).replace(/ Boon Npc$/, "") : null;
  log(who ? `A Blessed Meeting with ${who} started near the Envoy.` : "A Blessed Meeting started near the Envoy.");
  if (!Notification.isSupported() || !(await getSettings()).blessedNotify) return;
  const body = who
    ? `${who} is waiting near your Envoy, and today's boon is still available.`
    : "One just started near your Envoy, and today's boon is still available.";
  const n = new Notification({ title: "A Blessed Meeting is nearby", body, icon: ICON_PATH, silent: false });
  showNotification(n, "overview");
}

let recipesReady: Set<string> | null = null;
let recipesSeen: string | null = null;
async function checkRecipes(inv: InventoryView | null): Promise<void> {
  if (!inv || inv.updatedAt === recipesSeen) return;
  const defs = (await readDataJson<{ recipes?: Record<string, RecipeDef> }>("recipes.json"))?.recipes;
  if (!defs) return;
  recipesSeen = inv.updatedAt;
  const ready = readyRecipes(defs, inv.crafting);
  const before = recipesReady;
  recipesReady = ready;
  const settings = await getSettings();
  const fresh = newlyReady(before, ready, settings.recipeWatch);
  if (!fresh.length) return;
  log(`Starred recipes ready: ${fresh.map((t) => defs[t]!.name).join(", ")}.`);
  if (!settings.recipeNotify || !Notification.isSupported()) return;
  const line = (t: string) => {
    const r = defs[t]!;
    const times = recipeTimes(t, r, inv.crafting);
    return Number.isFinite(times) ? `${r.name} · enough for ${times.toLocaleString()}` : r.name;
  };
  const first = defs[fresh[0]!]!;
  const n = new Notification({
    title: fresh.length === 1 ? `Ready to ${recipeVerb(first)}: ${first.name}` : `${fresh.length} of your starred recipes are ready`,
    body: fresh.map(line).join("\n"),
    icon: ICON_PATH,
    silent: false,
  });
  showNotification(n, "recipes");
}

let totemsBefore: OwnedTotem[] | null = null;
async function checkTotems(inv: InventoryView | null): Promise<void> {
  if (!inv) return;
  const before = totemsBefore;
  totemsBefore = inv.totems;
  const settings = await getSettings();
  if (!before || !settings.totemWatch.length) return;
  const items = (await readDataJson<{ items?: Record<string, string> }>("names.json"))?.items ?? {};
  const nameOf = totemNamer(await readDataJson<Record<string, { types?: string[] }>>("totemdata.json"), items);
  const fresh = newStarredTotems(before, inv.totems, settings.totemWatch, nameOf);
  if (!fresh.length) return;
  log(`Starred Totems obtained: ${fresh.map((t) => nameOf(t.type)).join(", ")}.`);
  if (!settings.totemNotify || !Notification.isSupported()) return;
  const line = (t: OwnedTotem) => [nameOf(t.type), t.virtue, t.grip, `Rank ${t.rank}`].filter(Boolean).join(" · ");
  const n = new Notification({
    title: fresh.length === 1 ? `New Totem: ${nameOf(fresh[0]!.type)}` : `${fresh.length} of your starred Totems came in`,
    body: fresh.map(line).join("\n"),
    icon: ICON_PATH,
    silent: false,
  });
  showNotification(n, "upgrades");
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

const WINDOW_BG = "#14110f";
const EXTERNAL_LINKS = ["https://github.com/hunhow0x1/SFHelper", "https://github.com/sponsors/hunhow0x1", "https://ko-fi.com/hunhow0x1"];
const titleBarOf = (theme: Settings["theme"]) => (theme ? { ...theme.titleBar, height: TITLE_BAR.height } : TITLE_BAR);

function applyTheme(theme: Settings["theme"]): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(theme?.colors.bg ?? WINDOW_BG);
  try {
    mainWindow.setTitleBarOverlay(titleBarOf(theme));
  } catch (e) {
    log(`Couldn't recolour the title bar: ${(e as Error).message}`);
  }
}

function createMainWindow(url: string, theme: Settings["theme"]): void {
  const area = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1560, area.width),
    height: Math.min(980, area.height),
    backgroundColor: theme?.colors.bg ?? WINDOW_BG,
    title: "SFHelper",
    icon: ICON_PATH,
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOf(theme),
    webPreferences: { contextIsolation: true },
  });
  void mainWindow.loadURL(url);
  watchZoom(mainWindow.webContents);
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (EXTERNAL_LINKS.some((p) => target === p || target.startsWith(`${p}/`))) void shell.openExternal(target);
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

  restoreApiBackoff(await readRequests(Date.now() - BACKOFF_HISTORY_MS));
  const resumeAt = apiPausedUntil();
  if (resumeAt) log(`Soulframe refused SFHelper's last request, so SFHelper is waiting until ${new Date(resumeAt).toLocaleTimeString()} before sending another.`);

  onMoonsteelAcquired((p) => void notifyMoonsteel(p));
  server = await startServer(APP_PORT).catch(() => startServer(0));
  createMainWindow(server.url, (await getSettings()).theme);
  onSettingsChange((s) => applyTheme(s.theme));

  void refreshData();
  startUpdater(log);
  void armSavedTimers();
  setInterval(() => {
    for (const t of timerAlarms.due()) void notifyTimer(t);
    const crafted = craftAlarms.due();
    if (crafted.length) void notifyCrafts(crafted);
    void checkCollector().catch(() => {});
    void checkBlessed().catch(() => {});
  }, TIMER_CHECK_MS);
  void pruneRequests();
  void importFromMemory().finally(scheduleImport);
  setTimeout(() => void reportEarlierRefusals(), GAME_DATA_FIRST_MS);
  setTimeout(() => void gameData.check(), GAME_DATA_FIRST_MS);
  setInterval(() => void gameData.check(), GAME_DATA_CHECK_MS);
}

function askConsent(): Promise<boolean> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640,
      height: 580,
      resizable: false,
      backgroundColor: WINDOW_BG,
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
