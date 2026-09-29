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

import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { readConsent, recordConsent, ACK_PHRASE } from "../helper/consent";
import { importInventory } from "../helper/run";
import { startServer, type RunningServer } from "../src/server/server";
import { buildTotems, buildRunes, buildWeapons, buildPacts } from "../scripts/build_data";

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
    log("Refreshing totem/rune/weapon/pact data…");
    const [t, r, w, p] = await Promise.all([
      buildTotems(join(DATA_DIR, "totems.json")),
      buildRunes(join(DATA_DIR, "runes.json")),
      buildWeapons(join(DATA_DIR, "weapons.json")),
      buildPacts(join(DATA_DIR, "pacts.json")),
    ]);
    log(`Data updated: ${t.ok} totems, ${r.ok} runes, ${w.ok} weapons, ${p.ok} pacts.`);
  } catch (err) {
    log(`Effect data refresh failed (using bundled data): ${(err as Error).message}`);
  }
}

/** Run the read-only memory helper to import the live inventory. */
async function importFromMemory(): Promise<void> {
  const result = await importInventory({
    out: INVENTORY_PATH,
    configPath: CONFIG_PATH,
    consentPath: CONSENT_PATH,
    onLog: (m) => log(m),
    onProgress: (label, pct) => log(`${label}: ${pct}%`),
  });
  if (result.ok) {
    log(result.message);
    mainWindow?.webContents.reload(); // pick up the fresh inventory
  } else {
    log(`Inventory import skipped (${result.code}): ${result.message}`);
  }
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

  server = await startServer(0); // 0 = an OS-assigned free port
  createMainWindow(server.url);

  // Background work: refresh effect data on launch, then import the inventory.
  void refreshData();
  void importFromMemory();
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
