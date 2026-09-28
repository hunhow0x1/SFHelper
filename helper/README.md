# SFHelper memory helper (opt-in, ban-risk)

A **standalone** program that reads the running Soulframe process's memory to
recover the session nonce, then fetches your full owned inventory and writes it
to `inventory.json`. The main app imports that file through its ordinary
"Import a file" flow.

This directory is deliberately outside `src/`. Nothing in the app imports it,
and the app's provider registry rejects anything that touches the game process
(`touchesGameProcess`). Keeping the risky code in a separate process is the
whole design: run it yourself, on your terms, and the app only ever sees a file.

## The risk, stated plainly

It reads the game's memory. It **never writes** - `memoryReader.ts` opens
`/proc/<pid>/mem` read-only and exposes no write path. But reading a game's
memory is the behavior DE's clients are known to monitor for. Only run this on
an account whose risk you accept and have cleared for yourself.

## How it works

1. `consent.ts` - refuses to run until you record a ban-risk acknowledgement.
2. `processFinder.ts` - finds `Soulframe.x64.exe` (handles the 15-char
   `/proc/comm` truncation, like warframe-api-helper's `.exe`->`.ex` fallback).
3. `memoryReader.ts` - opens the process memory read-only, parses its maps.
4. `nonceLocator.ts` - gathers **candidate** nonces from the neighborhood of
   known anchors (your account id, the `&nonce=` request fragment). No
   hard-coded offset, so a game update at worst means widening the anchors here.
5. `fetchInventory.ts` - verifies candidates against the live endpoint (one at a
   time, stops on 403/429) and saves the first that returns real data.

The endpoint truth-checks the nonce, so the memory scan only has to surface it
among a short list - it never needs to be pinpointed exactly.

## Usage

```bash
# One time: record the acknowledgement.
node cli.js --ack "I understand reading the game's memory can risk my account and I accept that risk"

# With Soulframe running and logged in to a character:
node cli.js --account <your-24-hex-account-id> --out inventory.json
```

Then in the app, use **Import a file** and pick `inventory.json`.

## Linux notes

- Run as the same user that owns the game.
- `/proc/sys/kernel/yama/ptrace_scope` may need to be `0` for this session to
  read another process's memory.
- Under Proton/Wine the game is still a normal Linux process; `/proc/<pid>/mem`
  works the same way.

## What is NOT solved here

The anchors in `nonceLocator.ts` are heuristic and unverified against a live
Soulframe build - the self-verifying design tolerates that, but if no candidate
is accepted, the anchors are where to iterate. This has not been run
end-to-end from this repo; treat it as a starting point, not a finished tool.
