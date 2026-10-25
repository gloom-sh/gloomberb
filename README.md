# Watchlist front-contract verification

Before: `5ce0c7c5a08ec2eabc738a6789d5e8d9e9c80db4`. After: `5082af5ad9a787647561a868b97b15866c6b22e2`.

The real web renderer was pictured at 640 × 520 and 1280 × 520 in the dark (`white`) and light (`paper`) themes. Both sides used the same invented watchlist: deferred NGF27, continuous NG2, front NGX26.NYM, and AAPL. The deferred contracts retain their own prices and identify the front as `front NGX26 3.116`.

| Theme | Narrow | Wide |
|---|---|---|
| Dark | [Before and after, 640px](captures/compare-dark-640.png) | [Before and after, 1280px](captures/compare-dark-1280.png) |
| Light | [Before and after, 640px](captures/compare-light-640.png) | [Before and after, 1280px](captures/compare-light-1280.png) |

The default columns show the front reference at 1280px and hide the whole note at 640px. The standalone captures ending in `-name.png` also exercise a selected NAME column: the note follows the name when there is room. The front contract and ordinary stock have no note. Browser exception capture was empty on both sides.

The terminal smoke resized a populated watchlist from wide to narrow and back. It retained each row's own price, showed the front reference when it fit, and hid the complete note at the narrow size. Captures: [wide](terminal/wide.txt), [narrow](terminal/narrow.txt), [restored](terminal/restored.txt). [Memory observations](terminal/memory.txt) cover this short smoke; no runtime warning was found.

Both required terminal performance benchmarks passed with Bun 1.3.11: [navigation and memory results](terminal/performance.md).

The desktop and web share the DOM table renderer. A native desktop shell launch and authenticated views beyond sign-in or upgrade walls were not part of these captures.
