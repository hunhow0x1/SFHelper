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

Whether Soulframe exposes the same surface is **unverified**. What is known:
`content.soulframe.com` (Akamai, same edge pattern as `content.warframe.com`),
`origin.soulframe.com` and `api.soulframe.com` all resolve, which is the same
host layout Warframe uses - but resolving is not the same as serving, and the
paths have not been confirmed. `npm run probe` checks the candidates in
`data/endpoints.json` from your machine and writes what it finds.

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

## Open questions

1. Does any `content.soulframe.com/dynamic/*` path serve JSON? Run the probe.
2. Does Soulframe ship a `PublicExport` manifest? That would give item names
   and icons without touching account data at all.
3. What do real Soulframe `EE.log` lines look like? Every rule in
   `data/ee-log-rules.json` needs verifying against one.

## Sources

- [WFHelper](https://github.com/WFHelper/WFHelper) - its inventory sources are
  helper tool, JSON import, or AlecaFrame cache decryption
- [Sainan/warframe-api-helper](https://github.com/Sainan/warframe-api-helper) -
  memory scan, with its own ban warning
- [Warframe EULA](https://www.warframe.com/en/EULA) - RAM monitoring clause
- [WARFRAME Wiki: Public Endpoints](https://warframe.fandom.com/wiki/WARFRAME_Wiki:Public_Endpoints)
- [Soulframe third-party software policy](https://support.soulframe.com/hc/en-us/articles/39359876622349-Third-Party-Software-Policy)
