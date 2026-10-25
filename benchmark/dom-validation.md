DOM checks used Bun 1.3.11 and headless Chrome 155, with serialized browser runs at low scheduling priority. The three pointer checks that failed during an earlier diagnostic sweep each passed in a locked reproduction on both main and this change: floating-board table sizing, market-heat-map window resize, and Global Share. A complete locked pointer sweep was not completed.

The full drag/resize comparison completed ten alternating runs per side and failed the absolute 24 px pointer-lag budget in eight scenarios. Frame-time ratios, commit-count ratios, release jumps, and resting chart sharpness passed. The comparison is not green.

| Scenario | Main frame lag | Change frame lag |
|---|---:|---:|
| News table resize | 8.0 px | 24.8 px |
| Market heat map resize | 23.4 px | 39.6 px |
| Fear and greed resize | 51.6 px | 98.0 px |
| Dock divider beside a chart | 22.9 px | 32.8 px |
| G layout resize | 22.0 px | 26.8 px |
| Chart over a table resize | 4.9 px | 28.4 px |
| Dock divider beside a G layout | 35.3 px | 39.3 px |
| Dock divider beside a chart beside a table | 39.5 px | 38.2 px |

Three scenarios exceed the same absolute budget on main. The remaining lag failures were not established as pre-existing.
