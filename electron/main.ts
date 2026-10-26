/** SFHelper desktop shell (Electron main process).
 *
 *  Flow on launch:
 *    1. First run only: show the consent popup. Reading the game's memory is how
 *       every Soulframe companion obtains the session data; it is safe ONLY while
 *       it stays read-only, which this app guarantees. Nothing scans until the
 *       user agrees; declining quits.
 *    2. After consent: start the local dashboard server, open the window, and in
 *       the background (a) refresh the wiki-sourced totem/rune effect data, and
 *       (b) run the read-only memory helper to import the live inventory.
 *
 *  All per-user state lives under Electron's userData dir (SFHELPER_HOME).
 */

import { app, BrowserWindow, ipcMain, Notification, screen, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readConsent, recordConsent, ACK_PHRASE } from "../helper/consent";
import { importInventory, type ImportSession } from "../helper/run";
import { startServer, type RunningServer } from "../src/server/server";
import { onMoonsteelAcquired, type Pickup } from "../src/server/pickups";
import { getSettings } from "../src/server/settings";
import { setImportStatus } from "../src/server/importStatus";
import { startUpdater } from "./updater";
import { apiPausedUntil, noteApiAccepted, noteApiRefused, pausedMessage } from "../src/server/apiBackoff";
import { buildTotems, buildTotemData, buildRunes, buildWeapons, buildPacts, buildTempers, buildPactArts, buildTalismans, buildArmour, buildMasteryRank } from "../scripts/build_data";

const HERE = dirname(fileURLToPath(import.meta.url));

const USER_DATA = app.getPath("userData");
const CONSENT_PATH = join(USER_DATA, "consent.json");
const CONFIG_PATH = join(USER_DATA, "config.json");
const INVENTORY_PATH = join(USER_DATA, "inventory.json");
const DATA_DIR = join(USER_DATA, "data");
// Session log, so a tester can send it when something goes wrong
// (Windows: %APPDATA%\SFHelper\sfhelper.log). Started fresh each launch.
const LOG_PATH = join(USER_DATA, "sfhelper.log");

let server: RunningServer | null = null;
let mainWindow: BrowserWindow | null = null;

let logReady: Promise<void> | null = null;
function log(msg: string): void {
  console.log(`[sfhelper] ${msg}`);
  logReady ??= mkdir(USER_DATA, { recursive: true })
    .then(() => writeFile(LOG_PATH, `SFHelper ${app.getVersion()} on ${process.platform} ${process.arch}\n`))
    .catch(() => {});
  logReady = logReady.then(() => appendFile(LOG_PATH, `${new Date().toISOString()} ${msg}\n`)).catch(() => {});
}

/** Refresh totem/rune effect data from the wiki into the writable data dir. */
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
      // Optional: a wording change on the wiki shouldn't fail the whole refresh.
      buildArmour(join(DATA_DIR, "armour.json")).catch(() => ({ ok: 0 })),
      buildMasteryRank(join(DATA_DIR, "masteryrank.json")).catch(() => ({ ok: 0 })),
    ]);
    log(`Data updated: ${t.ok} totems, ${r.ok} runes, ${w.ok} weapons, ${p.ok} pacts, ${tp.ok} tempers, ${pa.ok} pact arts, ${td.ok} totem cards, ${tl.ok} talismans, ${ar.ok} armour pieces${mr.ok ? ", max Envoy Rank" : ""}.`);
  } catch (err) {
    log(`Effect data refresh failed (using bundled data): ${(err as Error).message}`);
  }
}

/** Run the read-only memory helper to import the live inventory. The dashboard
 *  polls the server on its own, and the server re-reads inventory.json when it
 *  changes, so there's no need to reload the window (which would reset UI state).
 *  We re-import periodically so pickups and progress stay near-current. */
let importing = false;
/** The last import's game session (pid, account, nonce), so the next import can
 *  reuse its nonce instead of re-scanning memory. In memory only - never saved. */
let session: ImportSession | undefined;
async function importFromMemory(): Promise<void> {
  if (importing) return; // don't overlap scans
  // DE refused us recently: don't scan or send anything until the pause ends.
  const paused = apiPausedUntil();
  if (paused) {
    setImportStatus({ state: "error", code: 8, message: pausedMessage(paused) });
    return;
  }
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
    if (result.ok) noteApiAccepted();
    // Keep the session through a refusal (8): the nonce may still work once
    // DE lets requests through again. Any other failure means it's gone stale.
    if (result.ok) session = result.session;
    else if (result.code !== 8) session = undefined;
    // 8 = DE refused (403/429): pause every request to DE, profile included.
    const message = result.code === 8 ? pausedMessage(noteApiRefused()) : result.message;
    log(result.ok ? result.message : `Inventory import skipped (${result.code}): ${result.message}`);
    setImportStatus(
      result.ok
        ? { state: "ok", message: "Inventory imported." }
        : { state: "error", code: result.code, message },
    );
  } catch (err) {
    // Unexpected failure (e.g. the native memory module failed to load).
    log(`Inventory import failed: ${(err as Error).stack ?? String(err)}`);
    setImportStatus({ state: "error", message: `Import failed: ${(err as Error).message}` });
  } finally {
    importing = false;
  }
}

const REIMPORT_INTERVAL_MS = 120_000; // re-scan for new pickups / progress every 2 min

/** In-game display name for an ItemType, from the bundled names.json (keyed by
 *  full path or leaf); falls back to a cleaned-up leaf. */
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

/** Desktop notification (with the system sound) for a new Moonsteel weapon.
 *  Clicking it brings SFHelper forward on the Pickups tab. Off when the user
 *  has turned the toggle on the Pickups tab off. */
async function notifyMoonsteel(p: Pickup): Promise<void> {
  if (!Notification.isSupported()) return;
  if (!(await getSettings()).moonsteelNotify) return;
  const name = await displayName(p.key);
  const craft = (p.craftwork && CRAFTWORK_NAME[p.craftwork]) || "";
  const how = p.source === "crafted" ? "crafted" : p.source === "purchased" ? "bought" : "picked up";
  const n = new Notification({
    title: `✦ Moonsteel ${name}!`,
    body: `You ${how} a Moonsteel ${name}${craft ? ` (${craft})` : ""}.`,
    silent: false,
  });
  n.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    void mainWindow.webContents.executeJavaScript(
      `typeof activateTab === "function" && activateTab("pickups")`,
    );
  });
  n.show();
  log(`Moonsteel ${name} acquired (${p.source ?? "pickup"}).`);
}

function createMainWindow(url: string): void {
  // Wide enough for the dashboard's multi-column layout, within the screen.
  const area = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1560, area.width),
    height: Math.min(980, area.height),
    backgroundColor: "#14110f",
    title: "SFHelper",
    webPreferences: { contextIsolation: true },
  });
  void mainWindow.loadURL(url);
  // Links out of the dashboard (the GitHub releases page) open in the browser.
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
  server = await startServer(0); // 0 = an OS-assigned free port
  createMainWindow(server.url);

  // Background work: refresh effect data on launch, then import the inventory,
  // then keep re-importing so pickups/leveling stay near-current while playing.
  void refreshData();
  startUpdater(log);
  void importFromMemory();
  setInterval(() => void importFromMemory(), REIMPORT_INTERVAL_MS);
}

/** The consent popup. Resolves true if the user agrees, false if they decline. */
function askConsent(): Promise<boolean> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640,
      height: 580,
      resizable: false,
      backgroundColor: "#14110f",
      title: "SFHelper — before you begin",
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
      if (!decided) resolve(false); // window closed without choosing = decline
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
  // Windows only shows toasts for apps with an App User Model ID (matches the
  // installer's appId).
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
