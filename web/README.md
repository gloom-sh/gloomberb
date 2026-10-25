# Signed-out web function captures

Base: `4c11d3c99f08`. Head: `badc3ac6257cba4a1bca1232f811580db4b844c7`.

The captures use runtime commit `319bb876541a55376e91e86f449a691723e54b4d`. The final commit adds only import-boundary entries; its runtime source and built assets are identical.

All four functions were absent from command suggestions and disappeared when restored from a saved layout on the base. On the head, 13F, ERN, EVTS and HDS appear in command results and each saved pane restores. The primary data routes are public; no new account or Pro gate was introduced.

The capture sheets show before on the left and after on the right, with rows ordered 13F, ERN, EVTS, HDS. Both widths (640 and 1280 px) and dark (`white`) and light (`paper`) themes are included. Original PNG captures are retained. Head captures read public data once and replay it across widths/themes; the separate all-pane comparison uses fixed offline data on both sides.

The focused token audit measured seven views across all four functions at both widths and passed without allowances. The all-pane sweep and blast-radius report are separate: official benchmark coverage at 640 and 1280 px in the dark (`white`) theme, including catalog functions, bundled and registry plugins, shell views, root/detail views, and root-tab alternatives at the official depth of one. `--no-variants` omits additional component/hover crops; it does not omit pane views. Light-theme coverage here is the four requested functions, not the all-pane sweep.

A separate boundary check replayed a 401 for HDS’s 13D/G request: the existing shared sign-in wall explained the account requirement, and its Log in action opened the auth dialog with a real mouse click. The live endpoint returned 200 signed out; this conditional-wall screenshot is a simulated denial, not the normal signed-out view.

Signed-in and Pro data, and a signed-out fallback during a primary data outage, are not covered by these captures.

## Catalog regression

[Before test output](before-test.txt) and [after test output](after-test.txt) run the same `src/plugins/catalog-browser.test.ts` from the fixed commit on each side with Bun 1.3.11. The main checkout fails browser command discovery on the missing 13F template; the fixed checkout passes all five catalog tests, including saved-layout restoration and CLI-catalog coverage.

To repeat the failing test, copy that test file from the fixed commit into a detached checkout of the base and run `bun test src/plugins/catalog-browser.test.ts`. No production source is changed in that comparison.

[The all-pane report](benchmark/summary.md) records **36 of 562 views changed, with 15 pictured on one side only**. [Its evidence notes](benchmark/README.md) explain coverage, repeated captures and the component-family comparisons. All reviewed stable changes are confined to restored functions, research tab strips and catalog listings.
