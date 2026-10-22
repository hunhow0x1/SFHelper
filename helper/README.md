# SFHelper memory helper

Reads the running Soulframe process's memory to find the session nonce, then
downloads your full inventory to `inventory.json`. The desktop app runs it
automatically every 2 minutes while the game is running, once you've agreed on
its consent screen. It can also be run on its own from the command line.

This directory is deliberately outside `src/`. The app's account-provider
registry rejects anything that touches the game process (`touchesGameProcess`),
so the only part of the app that uses this code is the Electron main process.

## Read-only, by construction

The helper **never writes** to the game's memory:

- **Linux:** opens `/proc/<pid>/mem` read-only.
- **Windows:** opens the process with `PROCESS_VM_READ | PROCESS_QUERY_INFORMATION`
  only. That handle physically can't write, and no write API is imported.

Neither backend exposes a write method, and the scan logic only ever calls
`read()`.

## How it works

1. `consent.ts` refuses to run until consent is recorded.
2. `processFinder.ts` finds `Soulframe.x64.exe`: through `/proc` on Linux,
   including Proton (with the 15-character `comm` truncation handled), and
   through `tasklist` on Windows.
3. `memoryReader.ts` opens the process read-only through the platform backend
   (`backends/linux.ts`, `backends/windows.ts`). It scans only writable private
   memory, in one pass for all search terms, yielding between chunks so the app
   stays responsive.
4. `accountIdLocator.ts` recovers your account id the first time. Candidates
   are confirmed against the public profile endpoint.
5. `nonceLocator.ts` collects **candidate** nonces near known anchors (your
   account id, the `&nonce=` request fragment). There's no hard-coded offset,
   so a game update means at worst widening the anchors.
6. `fetchInventory.ts` tries the candidates against the inventory endpoint one
   at a time, stops at once on 403/429, and saves the first that returns data.

The endpoint confirms which candidate is the real nonce, so the scan only has
to surface it among a short list. Once a nonce works, the app reuses it for the
rest of the session and only scans again if the game rejects it, for example
after a re-login.

## Command line

```bash
# One time: record consent.
npm run helper -- --ack "I understand reading the game's memory can risk my account and I accept that risk"

# With Soulframe running and logged in to a character:
npm run helper -- --out inventory.json            # finds your account id itself
npm run helper -- --account <24-hex-id> --out inventory.json
```

## Platform notes

- Run as the same user that owns the game.
- **Linux:** `/proc/sys/kernel/yama/ptrace_scope` may need to be `0`. Under
  Proton the game is an ordinary Linux process.
- **Windows:** if the game's memory can't be opened, run as administrator.
