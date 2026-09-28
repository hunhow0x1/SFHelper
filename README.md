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
