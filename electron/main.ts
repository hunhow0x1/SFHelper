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

import { app, BrowserWindow, ipcMain, Notification } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { readConsent, recordConsent, ACK_PHRASE } from "../helper/consent";
import { importInventory } from "../helper/run";
import { startServer, type RunningServer } from "../src/server/server";
import { onMoonsteelAcquired, type Pickup } from "../src/server/pickups";
import { getSettings } from "../src/server/settings";
import { buildTotems, buildRunes, buildWeapons, buildPacts, buildTempers, buildPactArts } from "../scripts/build_data";

const HERE = dirname(fileURLToPath(import.meta.url));

const USER_DATA = app.getPath("userData");
const CONSENT_PATH = join(USER_DATA, "consent.json");
const CONFIG_PATH = join(USER_DATA, "config.json");
const INVENTORY_PATH = join(USER_DATA, "inventory.json");
const DATA_DIR = join(USER_DATA, "data");

let server: RunningServer | null = null;
let mainWindow: BrowserWindow | null = null;

function log(msg: string): void {
  console.log(`[sfhelper] ${msg}`);
}

/** Refresh totem/rune effect data from the wiki into the writable data dir. */
async function refreshData(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    log("Refreshing totem/rune/weapon/pact/temper/pact-art data…");
    const [t, r, w, p, tp, pa] = await Promise.all([
      buildTotems(join(DATA_DIR, "totems.json")),
      buildRunes(join(DATA_DIR, "runes.json")),
      buildWeapons(join(DATA_DIR, "weapons.json")),
      buildPacts(join(DATA_DIR, "pacts.json")),
      buildTempers(join(DATA_DIR, "tempers.json")),
      buildPactArts(join(DATA_DIR, "pactarts.json")),
    ]);
    log(`Data updated: ${t.ok} totems, ${r.ok} runes, ${w.ok} weapons, ${p.ok} pacts, ${tp.ok} tempers, ${pa.ok} pact arts.`);
  } catch (err) {
    log(`Effect data refresh failed (using bundled data): ${(err as Error).message}`);
  }
}

/** Run the read-only memory helper to import the live inventory. The dashboard
 *  polls the server on its own, and the server re-reads inventory.json when it
 *  changes, so there's no need to reload the window (which would reset UI state).
 *  We re-import periodically so pickups and progress stay near-current. */
let importing = false;
async function importFromMemory(): Promise<void> {
  if (importing) return; // don't overlap scans
  importing = true;
  try {
    const result = await importInventory({
      out: INVENTORY_PATH,
      configPath: CONFIG_PATH,
      consentPath: CONSENT_PATH,
      onLog: (m) => log(m),
      onProgress: (label, pct) => log(`${label}: ${pct}%`),
    });
    log(result.ok ? result.message : `Inventory import skipped (${result.code}): ${result.message}`);
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
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    backgroundColor: "#14110f",
    title: "SFHelper",
    webPreferences: { contextIsolation: true },
  });
  void mainWindow.loadURL(url);
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
    app.quit();
  });
}

app.on("before-quit", () => {
  void server?.close();
});
