# UI audit: before and after

11 views before, 11 after.

Views in both runs: 11. Only before: 0. Only after: 0.

Not measured before (a tab the press did not select, a disabled one, a pane that did not open): none. After: none.

| Family | Variants before | Variants after | Looks before | Looks after | Functions off the main variant after |
|---|---:|---:|---:|---:|---|
| button | 7 | 7 | 6 | 6 | 8: CMP, FA, G, GP, HP, QQ, TOP, WEI |
| toggle | 6 | 6 | 4 | 4 | 5: CMP, FA, G, GP, HP |
| legend | 6 | 6 | 6 | 6 | 3: CMP, G, GP |
| toolbar | 5 | 5 | 5 | 5 | 6: CMP, FA, G, GP, HP, TOP |
| chip | 5 | 5 | 5 | 5 | 3: CMP, GP, TOP |
| pane-footer | 3 | 3 | 2 | 2 | 3: HP, QQ, WEI |
| table-header-cell | 3 | 3 | 2 | 2 | 2: TOP, WEI |
| table-row | 2 | 2 | 2 | 2 | 1: FA |
| pane-title-bar | 1 | 1 | 1 | 1 | 0 |
| input | 1 | 1 | 1 | 1 | 0 |
| axis | 1 | 1 | 1 | 1 | 0 |
| pane-hint | 1 | 1 | 1 | 1 | 0 |
| table-header-row | 1 | 1 | 1 | 1 | 0 |
| keycap | 1 | 1 | 1 | 1 | 0 |
| sort-indicator | 1 | 1 | 1 | 1 | 0 |
| back-row | 1 | 1 | 1 | 1 | 0 |
| link | 1 | 1 | 1 | 1 | 0 |
| table-section-row | 1 | 1 | 1 | 1 | 0 |

## Looks after, per family

### button

- `h=18 w=icon pad=0 4 0 4 border=0 radius=6 font=none fill=none`: 8 (CMP, FA, G, GP, HP, QQ, TOP, WEI)
- `h=18 w=icon pad=0 0 0 0 border=0 radius=0 font=none fill=none`: 8 (CMP, FA, G, GP, HP, QQ, TOP, WEI)
- `h=36 w=auto pad=0 0 0 0 border=0 radius=6 font=12/400 fill=none`: 1 (QQ)
- `h=16 w=auto pad=0 8 0 8 border=0 radius=3 font=12/700 fill=own`: 1 (TOP)
- `h=16 w=icon pad=0 8 0 8 border=0 radius=3 font=12/700 fill=own`: 1 (TOP)
- `h=19 w=auto pad=0 8 0 8 border=0 radius=0 shadow=c -1px 0px 0px font=12/400 fill=none`: 1 (TOP)

### toggle

- `h=19 w=auto pad=0 8 0 8 border=0 radius=0 font=12 fill=none`: 5 (CMP, FA, G, GP, HP)
- `h=19 w=icon pad=0 8 0 8 border=0 radius=0 font=12 fill=none`: 4 (CMP, G, GP, HP)
- `h=19 w=icon pad=0 8 0 8 border=0 radius=0 shadow=c 0px -2px 0px font=12 fill=none`: 4 (CMP, G, GP, HP)
- `h=19 w=auto pad=0 8 0 8 border=0 radius=0 shadow=c 0px -2px 0px font=12 fill=none`: 3 (FA, G, GP)

### legend

- `pad=0 0 0 8 border=0 radius=0 font=12 fill=none`: 2 (CMP, GP)
- `pad=0 0 0 0 border=0 radius=0 font=12 fill=none`: 2 (CMP, GP)
- `pad=0 0 0 0 border=1 radius=999 font=none fill=own`: 2 (CMP, GP)
- `pad=0 0 0 0 border=0 radius=0 font=none fill=own`: 1 (CMP)
- `pad=0 0 0 0 border=0 radius=0 font=none fill=none`: 1 (CMP)
- `pad=0 0 0 8 border=0 radius=0 font=none fill=none`: 1 (G)

### toolbar

- `pad=0 0 1 0 border=0 radius=0 shadow=c 0px -1px 0px font=12/400 fill=own`: 5 (CMP, FA, G, GP, HP)
- `pad=0 0 0 0 border=0 radius=0 font=12/400 fill=none`: 5 (CMP, FA, G, GP, HP)
- `pad=0 8 0 8 border=0 radius=0 font=none fill=own`: 3 (CMP, G, GP)
- `pad=0 0 1 0 border=0 radius=0 shadow=c 0px -1px 0px font=10/400 fill=own`: 1 (TOP)
- `pad=0 8 0 8 border=0 radius=0 shadow=c -1px 0px 0px font=10/400 fill=none`: 1 (TOP)

### chip

- `h=18 w=icon pad=0 4 0 4 border=0 radius=6 font=none fill=own`: 2 (CMP, GP)
- `h=18 w=icon pad=0 4 0 4 border=0 radius=6 font=none fill=none`: 2 (CMP, GP)
- `h=18 w=auto pad=0 0 0 0 border=0 radius=0 font=12/700 fill=none`: 1 (TOP)
- `h=18 w=auto pad=0 8 0 0 border=0 radius=0 font=12/700 fill=none`: 1 (TOP)
- `h=18 w=icon pad=0 8 0 0 border=0 radius=0 font=12/700 fill=none`: 1 (TOP)

### pane-footer

- `h=20 pad=0 8 0 8 border=1/0/0/0 radius=0 font=12 fill=own`: 8 (CMP, FA, G, GP, HP, QQ, TOP, WEI)
- `h=20 pad=0 8 0 8 border=1/0/0/0 radius=0 font=none fill=own`: 1 (QQ)

### table-header-cell

- `h=20 pad=0 0 0 0 border=0 radius=0 font=12 fill=own`: 4 (FA, HP, TOP, WEI)
- `h=20 pad=0 0 0 0 border=0 radius=0 font=none fill=own`: 1 (WEI)

### table-row

- `h=18 pad=0 8 0 8 border=0 radius=0 font=12/400 fill=own`: 4 (FA, HP, TOP, WEI)
- `h=18 pad=0 8 0 8 border=0 radius=0 font=12/700 fill=own`: 1 (FA)

### pane-title-bar

- `h=20 pad=0 8 1 8 border=0 radius=0 shadow=c 0px -1px 0px font=12/700 fill=own`: 8 (CMP, FA, G, GP, HP, QQ, TOP, WEI)

### input

- `h=18 w=auto pad=0 0 0 0 border=0 radius=0 font=none fill=none`: 4 (CMP, G, GP, TOP)

### axis

- `pad=0 0 0 0 border=0 radius=0 font=12 fill=none`: 3 (CMP, G, GP)

### pane-hint

- `h=18 pad=0 0 0 0 border=0 radius=6 font=12 fill=none`: 6 (CMP, FA, G, GP, QQ, TOP)

### table-header-row

- `h=20 pad=0 8 0 8 border=0 radius=0 font=12/700 fill=own`: 4 (FA, HP, TOP, WEI)

### keycap

- `h=14 w=icon pad=0 4 0 4 border=0 radius=3 shadow=c 0px 0px 0px font=10 fill=own`: 1 (TOP)

### sort-indicator

- `h=9 pad=0 0 0 0 border=0 radius=0 font=none fill=none`: 1 (TOP)

### back-row

- `h=20 pad=0 0 1 0 border=0 radius=0 shadow=c 0px -1px 0px font=12/400 fill=own`: 1 (TOP)

### link

- `pad=0 0 0 0 border=0 radius=0 font=12/400/underline fill=none`: 1 (TOP)

### table-section-row

- `h=18 pad=0 8 0 8 border=0 radius=0 font=12/700 fill=own`: 1 (WEI)


| Measure | Before | After | Before: values (views) | After: values (views) |
|---|---:|---:|---|---|
| Font sizes (fitted chart labels left out) | 7 | 7 | 12 (11), 20 (3), 15 (2), 11 (2), 10 (1), 14 (1), 16 (1) | 12 (11), 20 (3), 15 (2), 11 (2), 10 (1), 14 (1), 16 (1) |
| Font weights | 2 | 2 | 700 (11), 400 (11) | 700 (11), 400 (11) |
| Radii | 4 | 4 | 0 (11), 6 (11), 999 (2), 3 (2) | 0 (11), 6 (11), 999 (2), 3 (2) |
| Shadows | 4 | 4 | c 0px -1px 0px 0px inset (11), c 0px -2px 0px 0px inset (6), c -1px 0px 0px 0px inset (2), c 0px 0px 0px 1p (1) | c 0px -1px 0px 0px inset (11), c 0px -2px 0px 0px inset (6), c -1px 0px 0px 0px inset (2), c 0px 0px 0px 1p (1) |
| Colours of 1px rules | 5 | 5 | mixed (color-mix) (11), token or helper rule (10), mixed hairline (9), off-palette rgb(246, 200, 95) (2), off-palette rgb(77, 171, 247) (1) | mixed (color-mix) (11), token or helper rule (10), mixed hairline (9), off-palette rgb(246, 200, 95) (2), off-palette rgb(77, 171, 247) (1) |
| Pane body left inset at 640px | 4 | 4 | 8 (7), 10 (2), 26 (1), 23 (1) | 8 (7), 10 (2), 26 (1), 23 (1) |
| Pane body left inset at 1280px | 4 | 4 | 8 (7), 10 (2), 26 (1), 23 (1) | 8 (7), 10 (2), 26 (1), 23 (1) |

## Pictures compared

44 picture pairs compared, 0 could not be compared, 0 pictures without a partner. A pair that could not be compared or has no partner is not counted as unchanged.

| Engine | Pairs compared | Moved (> 0.05% of pixels, or resized) | Could not compare | Only before | Only after |
|---|---:|---:|---:|---:|---:|
| chromium | 44 | 8 | 0 | 0 | 0 |

## Views that moved

2 of 11 views differ by more than 0.05% of their pixels, or in size, in some engine, theme or width; 0 could not be compared somewhere.

