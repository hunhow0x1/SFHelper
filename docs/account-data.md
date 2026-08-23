# Getting account data out of Soulframe, safely

The hard part of a companion app is not the UI - it is that the game gives you
no supported way to read your own account. Every technique below has been used
by Warframe tooling; they differ enormously in what they cost the player if it
goes wrong.

## The ranking

| # | Technique | Credentials | Touches the game | Verdict |
|---|-----------|-------------|------------------|---------|
| 1 | Public unauthenticated endpoint | none | no | **Best, if it exists** |
| 2 | User-supplied file import (incl. DE data request) | none | no | **Always ship this** |
| 3 | `EE.log` parsing | none | no (read-only file) | **Ship, with an opt-in** |
| 4 | Screen capture + OCR | none | reads pixels | Fine, but expensive to build |
| 5 | Logging in with the player's DE password | **yes** | no | Do not ship |
| 6 | Scraping the session token from game memory | steals one | **yes** | Do not ship |

### 1. Public unauthenticated endpoints

Warframe serves the data behind the in-game profile viewer from
`content.warframe.com/dynamic/getProfileViewingData.php?n=<name>` - no login,
no token, per-platform mirrors under `api*.warframe.com/cdn/`. Community tools
have read profiles this way for years. It is the only technique where a
mistake in your code cannot cost someone their account.

Soulframe exposes the same surface. Read out of `Launcher.log`'s own HTTP
transcripts and `EE.log` error lines, then probed directly:

| Endpoint | Result |
|---|---|
| `api.soulframe.com/cdn/getProfileViewingData.php?playerId=` | **200 - 45KB of real profile JSON, unauthenticated** |
| same endpoint, `?n=<displayName>` | 200 but always empty - the name lookup is not wired up here, unlike Warframe |
| `api.soulframe.com/api/clientIP.php` | 200 - diagnostic; returns the caller's IP and city, never log it |
| `origin.soulframe.com/origin/<hash>/index.txt.lzma` | 200 - client download manifest, 250 entries |
| `content.soulframe.com/Lotus/...` | 200 - static content, `/Lotus/` namespace as in Warframe |
| `worldState.php` (both hosts, both paths) | 404 |
| `inventory.php`, `getShip.php` | session-authenticated - **not probed, out of policy** |

Two things that shape the app. There is **no PublicExport equivalent**: the
origin index lists binaries, language RTFs and `Cache.Windows/*.toc` files,
with no item exports - so static item data has to come from the community or
from the asset caches, not from a clean DE feed. And `worldState.php`, which
is public in Warframe, is not reachable at either obvious path.

If a profile endpoint turns up, it is still a *curated* view - the profile
viewer shows far less than the account holds - so treat it as `partial`.

### 2. File import

The user picks a file; you parse it. Costs nothing, works forever, and the
trust decision belongs to the person who owns the data. Two useful flavours:

- Exports from any community tool the player already uses.
- A **GDPR/CCPA data request to Digital Extremes**. This is the officially
  sanctioned route to your own account data. It is slow (weeks) and manual,
  so it is a seed, not a sync - but it is the only source that is both
  complete and unambiguously allowed.

### 3. `EE.log`

Soulframe runs DE's Evolution engine and writes the same style of engine log
Warframe does; the launcher's gear-wheel -> **Get Logs** dumps it to the
desktop. Reading a text file the game already wrote is not instrumentation -
no credentials, no contact with the process. It is how WFHelper tracks
arbitration runs.

The catch is that the format is undocumented and shifts between Preludes
builds, so the line grammar lives in `data/ee-log-rules.json` and every rule
carries a confidence. Rules below `likely` are skipped unless the caller opts
in, so a wrong guess produces no data rather than wrong data. **None of the
shipped patterns have been checked against a real Soulframe log** - do that
first, then mark them `verified`.

### 5 and 6: why not

These two produce the best data, which is exactly why people reach for them.

**Credential login.** Warframe's API takes an email and a password hash and
returns a session token. There is no OAuth, no scoping, no revocation. A DE
account is one credential covering Warframe, Soulframe, the forums and store
purchases, so an app that asks for it is asking the player to bet all of that
on your storage, your build pipeline and your dependency tree. Any breach is
account takeover, not a leaked inventory list.

**Memory scraping.** The alternative is to read the session token out of the
running game - which is what `warframe-api-helper` does, and it warns you
about a possible ban and makes you type an acknowledgement before its first
scan. That warning is well founded: DE's EULA states the client may monitor
RAM for unauthorized third-party programs and report the account name and
what it found back to DE. Note that even WFHelper does not do this in-tree -
it downloads a separate tool the user consents to run, which moves the risk
without removing it.

Soulframe raises the stakes further: Preludes is a test build under NDA-ish
conditions with a small population, where anything anomalous is easy to spot.

## What this repo does about it

The rule is enforced in code, not in a README. `ProviderRegistry.register()`
throws `UnsafeProviderError` on any provider whose metadata declares
`requiresCredentials` or `touchesGameProcess`, so a risky source cannot reach
the UI even by accident. Changing that policy means editing
`src/account/provider.ts` in a reviewable commit.

Everything else follows from one consequence: **the safe sources are all
incomplete.** No single one gives you the account, so the app is built to
accrete rather than to sync.

- `AccountSnapshot` (`src/account/snapshot.ts`) is the only shape features
  read. Providers exist to produce it.
- Every entry carries a `SourceRef` with a fidelity: `full`, `partial`, or
  `observed`.
- `mergeSnapshots()` lets only a `full` capture delete. A log line proves an
  item exists; its absence proves nothing, so observed data can add and
  update but never contradict.
- Account ids are hashed at the boundary (`identity.ts`), so a snapshot
  attached to a bug report does not identify the player.
- Network etiquette lives in the provider: one request at a time, a floor on
  spacing, an identifying `User-Agent`, and a hard stop on 403/429 rather
  than a retry loop. Players have had IPs firewalled by DE for hammering
  these hosts.

## What the profile endpoint gives you

Confirmed against a live account. No login, no token - just an account id.

```
Results[0]
  DisplayName, PlayerLevel, Created, MigratedToConsole
  Affiliations        4 syndicates with Standing and Title
  ChallengeProgress   1
  LoadOutInventory    Suits / LongGuns / Melee / WeaponSkins (equipped only)
                      XPInfo: 55 items with earned XP  <- mastery-style progression
  LoadOutPreset, OperatorLoadOuts, DailyAffiliation, DailyAffiliationOde
Stats                 16 keys: Weapons[85], Enemies[128], TimePlayedSec,
                      MeleeKills, Deaths, PickupCount, Income, HealCount, ...
TechProjects, XpComponents   (empty on this account)
```

That is enough to build a real companion: a progression tracker off `XPInfo`,
per-weapon and per-enemy stats, syndicate standing, playtime. What it does
**not** contain is the owned-item inventory - no resources, no currencies, no
unequipped gear. Those live behind `inventory.php`, which needs a session, so
they stay out of reach by design. Scope the app accordingly.

## The account id problem

The endpoint keys on a 24-hex Mongo ObjectId, and **nothing on disk hands the
player their own id**. It is in no Soulframe log and not in `EE.cfg`. The only
local copy found was `Avakot.org/littleGenius/metadata.json`
(`last_active_account`), which exists only if the player uses Little Genius.

So the app needs a one-time "paste your account id" step. Worth checking
whether a signed-in session on soulframe.com exposes it somewhere the user can
copy - that keeps the credential entirely inside their browser, which is the
line we care about.

## EE.log leaks other players' identities

Squad lines pair account ids with IP addresses:

```
SquadOverlay.lua: Accepting invitation to join <name> in <sessionId>
  hosted by 66d62da2aaa56f7bce0e5983 (StrictNAT: <ip>)
Net [Info]: Phase 0 - requesting introduction ... from <accountId> (<ip>:4960)
```

Those ids are other people's, and they resolve against the same public profile
endpoint. Two consequences: never upload or share raw EE.log content, and
never persist ids parsed out of it. `Launcher.log` separately contains the
local player's own public IP and city.

## What EE.log actually contains

Verified against build `2026.08.20.11.07`. The line grammar in
`data/ee-log-rules.json` matched every line, and login events are detectable
(`Background::OnLoginDone()`, `MainMenu.lua: DispatchLogin()`).

It contains **no inventory, no account id and no display name**. The only
inventory trace is `Bad data from inventory.php:` followed by
`Unknown property: <Field>` lines - the client naming fields it failed to
parse. That leaks the schema for free:

```
Suits  LongGuns  Melee  WeaponSkins  Quests  Conquests  Descents
Mailbox  LoadOutInventory  CalendarProgress  ChallengeProgress  WebFlags
```

Warframe-shaped, which is why the `json-import` parser already handles most
of it. But schema is not data: treat EE.log as a session and run tracker,
never as an inventory source.

## Prior art: Little Genius

The shipping Soulframe companion ([Avakot](https://lg.avakot.org/)) is a
Tauri app that arrives at the same architecture independently:

- Its only hook into the game is `ee_log_path.cache`, pointing straight at
  `EE.log`. No memory scanning, no credential store.
- Its webview talks to `wiki.avakot.org`, `soulmap.avakot.org` and
  `avakot.market` - its own services for static data. It contacts no
  `soulframe.com` origin at all.
- Its local store is encrypted at rest and keyed by DE account id.

Worth knowing that the encrypted-at-rest choice is theirs to make and not
obviously right for us: an unreadable local store also means the user cannot
inspect or export their own data.

## Open questions

1. Where can a player read their own account id without a third-party app?
2. How often does the profile endpoint update - live, or on some cache delay?
3. Where does `worldState.php` actually live, if anywhere public?
4. Static item names and icons: community dataset, or `Cache.Windows`
   extraction with its copyright caveats?

## Sources

- [WFHelper](https://github.com/WFHelper/WFHelper) - its inventory sources are
  helper tool, JSON import, or AlecaFrame cache decryption
- [Sainan/warframe-api-helper](https://github.com/Sainan/warframe-api-helper) -
  memory scan, with its own ban warning
- [Warframe EULA](https://www.warframe.com/en/EULA) - RAM monitoring clause
- [WARFRAME Wiki: Public Endpoints](https://warframe.fandom.com/wiki/WARFRAME_Wiki:Public_Endpoints)
- [Soulframe third-party software policy](https://support.soulframe.com/hc/en-us/articles/39359876622349-Third-Party-Software-Policy)
