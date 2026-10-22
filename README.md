# SFHelper

A desktop companion for **Soulframe**, in the spirit of
[WFHelper](https://github.com/WFHelper/WFHelper). It tracks your faction
standing, mastery, loadouts, totems and weapon pickups while you play, using
in-game names throughout.

Runs on **Linux** (AppImage) and **Windows** (installer or portable zip).

## Features

| Tab | What it shows |
|---|---|
| **Overview** | Faction standing and titles, the daily standing cap counting down, standing earned today per faction, faction tokens and currencies. |
| **Loadouts** | Each loadout's Pact (with its Pact Arts tree), weapons, Runes, Totems by slot, Tempers and Joinery (e.g. *Gildaur: Thrice Blessed by Mora*). Virtue totals match the Arsenal, with a breakdown: allocated points, Pact Arts, Talisman and Fables. Loadouts can be shared as short `SFH1:` codes. |
| **Mastery** | Your Envoy Rank, an estimate of progress to the next rank, and the patch's maximum rank. Every weapon and pact shows its Mastery, which comes from the game's own record, so a re-crafted weapon still counts. Filter by owned, mastered and type. |
| **Upgrades** | Tuvalkane temper learning, and your Totem inventory with search and grip / Virtue / type filters. |
| **Pickups** | Weapons you've picked up, with times taken from the game's log. Optional desktop notifications for Moonsteel finds. |
| **Stats** | Your top weapons and enemies by kills, by in-game name. |

## How it gets your data

- **Public profile:** standing, level and combat stats come from Soulframe's
  public profile endpoint. No login is involved. The page refreshes every 30
  seconds, and requests are cached so the endpoint isn't hit more often.
- **Inventory, read from the running game (desktop app, opt-in):** Soulframe
  doesn't offer the full inventory any other way, so the desktop app reads a
  session token from the game's memory and uses it to download your inventory.
  - Access is **read-only**: memory is opened without write rights, and there is
    no write path anywhere in the code.
  - Nothing runs until you agree on the first-launch consent screen.
  - While the game is running, the inventory is refreshed every 2 minutes. The
    memory is only scanned when your session changes.
- **Game log:** `EE.log` supplies the time each weapon was picked up.
- **Reference data:** totem, rune, temper, weapon, pact and talisman details
  come from the [Soulframe Wiki](https://wiki.avakot.org) and are refreshed
  each time the app starts; a bundled copy is used if the wiki can't be
  reached. In-game names come from the game's own text.
- **Rate limits:** if Soulframe's servers ever refuse a request (403/429),
  SFHelper stops all requests to them, for 15 minutes at first and up to an hour.

## Install and run

**Linux:** make the AppImage executable and run it.

```bash
chmod +x SFHelper-0.1.0.AppImage
./SFHelper-0.1.0.AppImage
```

**Windows:** run `SFHelper-Setup-0.1.0.exe`, or unzip the portable build and
run `SFHelper.exe`.

Start Soulframe, log in to a character, then open SFHelper. It finds your
account by itself; there's nothing to type in.

### Your data and the log

Everything stays on your machine:

| | Folder |
|---|---|
| Linux | `~/.config/sfhelper/` |
| Windows | `%APPDATA%\sfhelper\` |

`sfhelper.log` in that folder records each session's imports and errors. It's
the file to send when something isn't working.

### Troubleshooting

- **"Waiting for Soulframe…"**: the game isn't running, or you haven't logged
  in to a character yet.
- **Can't read the game's memory:**
  - Run SFHelper as the same user as the game.
  - On Windows, try **Run as administrator**.
  - On Linux, `/proc/sys/kernel/yama/ptrace_scope` may need to be `0`.
- **"Soulframe is refusing requests… Pausing until HH:MM"**: SFHelper is
  backing off after a refusal from Soulframe's servers. It retries on its own.

## Building from source

Requires Node.js 22 or newer.

```bash
npm install
npm run app            # build and launch the desktop app
npm run dist:linux     # -> release/SFHelper-<version>.AppImage
```

### Windows installer from Linux

electron-builder needs **Wine** to build the Windows installer on Linux. On
Bazzite and other atomic distros, the simplest way is a distrobox:

```bash
distrobox create --name sfbuild --image registry.fedoraproject.org/fedora-toolbox:44
distrobox enter sfbuild
sudo dnf install -y wine nodejs npm

# inside the box, from the project folder:
WINEPREFIX="$HOME/.local/share/sfbuild-wine" WINEDEBUG=-all npm run dist:win
# -> release/SFHelper-Setup-<version>.exe
```

The build must run **inside** the box: Wine installed there isn't visible to the
host. To build the portable zip instead, which doesn't need Wine, run
`npm run build:app && npx electron-builder --win zip`.

### Browser-only dashboard

`npm start` serves the dashboard at <http://localhost:4317> without Electron.
It reads only the public profile, plus an `inventory.json` if one is in its
data folder; there's no memory import.

## Development

```bash
npm run typecheck
npm test
```

**Refreshing bundled data:** the app refreshes most of this at launch.

| Command | Source | Output |
|---|---|---|
| `npm run build-totems` / `build-totemdata` / `build-runes` / `build-tempers` / `build-pactarts` / `build-weapons` / `build-pacts` / `build-talismans` / `build-masteryrank` | Soulframe Wiki | `src/server/public/*.json` |
| `npm run build-tempericons` | Soulframe Wiki (game art) | `src/server/public/img/tempers/` |
| `npm run extract-names -- --out dict.en.json`, then `node scripts/build_names.mjs dict.en.json src/server/public/names.json` | Game localization (DE's CDN) | `names.json` |
| `npm run build-enemies -- dict.en.json` | Game localization + cached game type tree | `src/server/public/enemies.json` |

Decompression uses [`ooz-wasm`](https://www.npmjs.com/package/ooz-wasm), an
open-source WASM decompressor installed by `npm install`.

### Layout

```
electron/        Desktop app: window, consent screen, memory import loop, notifications
src/server/      Local dashboard server and parsers (inventory, loadouts, mastery, standing, pickups)
src/server/public/  The dashboard page and its bundled data
src/account/     Account snapshot providers (public profile, file import, EE.log)
helper/          Read-only memory reader (Linux /proc, Windows ReadProcessMemory) - see helper/README.md
scripts/         Data builders and game-file extractors
docs/            Background research on Soulframe's account data sources
tests/           Vitest suites
```

## Ground rules

- **Read-only.** SFHelper never writes to the game's memory, and is built so
  that it can't.
- **Opt-in.** The memory import doesn't run until you agree to it, and stops if
  you clear SFHelper's data.
- **No credentials.** SFHelper never asks for your Soulframe or Digital
  Extremes login.
- **Local.** Your data stays on your machine.
- **Gentle on DE's servers.** Requests are cached, made one at a time, and
  stopped as soon as the servers say no.
