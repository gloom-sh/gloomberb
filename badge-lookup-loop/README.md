# Ticker badge lookup loop: repro scripts and results

- `fixture.tsx` + `fixture-drive.ts`: the row-message shots' Buildout fixture (no plugin registry), with `?ticker=` for the first company. Builds the page from a checkout (`APP=<checkout>`), stars the first company with `s`, a click or `KEY=j`, and probes whether the page still answers.
- `web-drive.ts`: the real web build with TheBuildout compiled in (the browser build leaves it out; `src/plugins/builtin/cloud/browser.tsx` given `buildoutModule` for this run only, built with `bun scripts/build-web.ts --out <dir>`), signed in as a stand-in user with access. Gloom Cloud reads go through the UI sweeps' replay; TheBuildout's API and the account calls are answered locally, so no star reaches any service. Opens TBO, opens All Companies, clicks the first company's star with a real pointer (or `s`, `HOVER=1` to rest the pointer on the badge first).
- `tui-preload.ts`: the real terminal app (`bun --preload tui-preload.ts src/cli/entry.ts` in tmux) with only TheBuildout's account and API answered locally. `cpu.sh <pid> <s>` reads the CPU it used.

Commits per second are React commits counted through the DevTools hook; script time is Chrome's ScriptDuration.

| Path | Ticker | main | this branch |
|---|---|---|---|
| Fixture (no registry) | NVDA | 4,700 to 7,000 commits/s at rest, 0 DOM changes; the click, `s` or even `j` never returns | 0 commits at rest; the star answers in under 30 ms |
| Fixture (no registry) | none | fine | fine |
| Web build, real registry, real pointer | NVDA, 2330, 005930, 700, SIE, 8035, BRK.B, ZZQXW | fine | fine |
| Web build, real registry, real pointer | BRK-B, TTF | badge stuck looking up, 1,000 to 4,500 commits/s and about 900 ms of script per second at rest; the star click never returns | badge reads BRK.B / TTF=F, 0 commits at rest, the star answers in under 15 ms |
| Terminal (tmux), real app | NVDA | fine | fine |
| Terminal (tmux), real app | TTF | badge stuck at `TTF …`, about 1.5 s of CPU per 3 s at rest; the star still draws (no input event runs the loop synchronously there) | `TTF +3.6%`, 50 ms of CPU per 3 s at rest |
