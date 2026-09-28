# SFHelper

A desktop companion for **Soulframe**, in the spirit of
[WFHelper](https://github.com/WFHelper/WFHelper).

This repo currently contains the piece everything else depends on: the account
data layer - how player data gets in, and the rules that keep getting it in
from costing anyone their account.

## Run the dashboard

A local app you run alongside Soulframe. It fetches your public profile and
shows faction standing, weapon/pact XP, and combat stats, refreshing every
minute. No login, no game-memory access - just the public profile endpoint.

```bash
npm install
npm start           # serves http://localhost:4317
```

Open the URL, paste your 24-character account id, and click **Track**. The id
is remembered in your browser for next time.

## In-game names (hostable endpoint)

The dashboard shows in-game names (e.g. `Igne Mora`, not `FennJotarSword`) from
a name dictionary. The app pulls it from an endpoint you host, caches it for a
day, and falls back to the small bundled seed when the endpoint is unset or
down. Point it at your host with either:

```bash
export SFHELPER_NAMES_URL="https://your-host.example/soulframe-names.json"
# or add {"namesUrl": "..."} to ~/.config/sfhelper/config.json
```

The file it serves is:

```json
{
  "items":    { "FennJotarSword": "Igne Mora", "/SF/Souls/Ode/OdeSoul": "Ode" },
  "factions": { "SilentRoseSyndicate": "Silent Rose" }
}
```

`items` keys may be a full `ItemType` path (most precise) or the leaf token;
lookups try full path, then leaf, then a cleaned-up guess.

### Producing the names file

The names come from the game's own localization (`Languages.bin` on DE's CDN),
extracted with no proprietary dependency - Oodle decompression uses `ooz-wasm`
(an open-source WASM Kraken decompressor pulled in by `npm install`, nothing to
fetch by hand):

```bash
npm install
node scripts/extract_names.mjs --out dict.en.json    # download + decompress the dict
node scripts/build_names.mjs dict.en.json names.json  # -> { items, factions }
```

Host `names.json` at your `SFHELPER_NAMES_URL`. Re-run per patch. Factions map
exactly; item names resolve by leaf where the localization key aligns with the
profile's `ItemType`. The precise `ItemType -> name` bridge for the rest needs
the item definitions (in the `Cache.Windows` packages, decompressible with the
same `ooz-wasm`) - a follow-on step.

`scripts/unpack_cache.py` / `extract_names.py` are the earlier ctypes-Oodle
prototypes, kept for reference; the `.mjs` pipeline above is the integrated,
dependency-free one.

## Read this first

[`docs/account-data.md`](docs/account-data.md) - the six ways to pull Soulframe
account data, what each one risks, and why two of them are refused at
registration time rather than discouraged in prose.

## Layout

```
src/account/snapshot.ts        AccountSnapshot: the one shape features read
src/account/provider.ts        Provider contract + registry that rejects unsafe sources
src/account/identity.ts        Account ids are hashed at the boundary
src/account/providers/         json-import, ee-log, public-web
data/endpoints.json            Public endpoint candidates (nothing confirmed yet)
data/ee-log-rules.json         EE.log line grammar, per-rule confidence
scripts/probe-endpoints.mjs    Discover which public endpoints actually exist
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run probe -- --displayName "YourName"   # run on your own machine
```

`npm run probe` issues plain unauthenticated GETs to the candidate URLs in
`data/endpoints.json`, one at a time, and stops on the first 403/429. Move
anything that returns real data into that file's `confirmed` list - the
`public-web` provider reports itself unavailable until something is there.

## Ground rules

- No provider asks for a Soulframe or Digital Extremes credential.
- No provider reads, writes to, or attaches to the game process.
- Account data stays on the player's machine; account ids are stored hashed.
