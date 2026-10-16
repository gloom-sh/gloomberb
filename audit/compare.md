# All-pane UI audit, main against this branch

`bun run audit:ui --widths 640,1280 --themes white,paper` on main (06792df44) and on this branch on the same base, against one shared replay of Gloom Cloud's signed-out answers. Chromium; 160 functions and plugin panes plus the shell views, each with its detail and tabs.

- 1886 view pictures in both runs: 1841 pixel-identical (ImageMagick AE, 3% fuzz), 45 differ, 5 opened in one run only.
- The 22 functions with a difference (BI, BR, CDS, CHOKE, CMP, COT, CRD, DIST, EPWR, FDA, FLOW, GIP, HALT, MARS, NI, OVDV, PERP, PL, POLL, QR, TAS, THEM) were run again on both checkouts. Two runs of the same checkout differ on the same functions (46 pictures on main, 36 on this branch): live trades and NBBO, volatility surfaces, and panes caught loading in one run and loaded in the other. None of them shows a browser sign-in panel, a sign-in or connect dialog, or a form step.
- The views this change draws differently are not part of the audit (it opens panes and dialogs signed out); they are compared in `fixture/` and `terminal/`.

Sheets: `main/` and `branch/`, `chromium-<theme>-<width>-<page>.jpg`, 30 views a sheet, with each run's `report.md`.
