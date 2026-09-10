# Contributing

## Running locally

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/gloom-sh/gloomberb.git
cd gloomberb
bun install
bun dev
```

## Building plugins

See [PLUGINS.md](PLUGINS.md) for a guide on building your own plugins.

## Browser development

```bash
bun run web:build
bunx wrangler dev
```

Validate the public artifacts with `bun run web:audit` and `bun run cloudflare:dry-run`. `wrangler.jsonc` is the local configuration. After verification passes on `main`, GitHub Actions deploys `term.gloom.sh` with `wrangler.production.jsonc`. The private Gloom Cloud API is deployed separately.

Cloud REST and WebSocket traffic uses the same-origin `/api` path, which the Worker forwards only to `https://api.gloom.sh`; it is not an arbitrary network proxy. Public shares open under `/s/:id` in a separate slim bundle. Share creation and owner deletion use the signed-in Gloom Cloud session through the same API path; public reads require no account.

See the [browser guide](docs/browser.md) for account requirements and supported features.

## Localization

- Locale dictionaries live in [src/i18n](src/i18n), keyed by the original English UI text. Missing entries safely fall back to English.
- Shared render sinks call `t()` / `tf()` / `tc()` for pane titles, the command bar, menus, settings, tabs, help, and onboarding.
- Finance abbreviations such as BID, ASK, and CHG% intentionally remain in English for terminal conventions and fixed-width alignment.
- CJK wide characters and grapheme clusters are measured by [src/utils/format.ts](src/utils/format.ts) using terminal display-cell widths.
