# FOOTER-COPY CI UI artifact review

Run: https://github.com/gloom-sh/gloomberb/actions/runs/39618670567
Observed: 2026-10-21T16:42:47.088428+00:00. Workflow: completed / success.
Artifact audit complete: 4/4 finished shard artifacts downloaded; final comparison artifact present.

Workflow head: `c1810dd09dea69bdb2f00de498f62067528a6ec2`. Actual compared revisions from each shard:

| Shard | Base | Tested head | Clean | Offline |
|---|---|---|---|---|
| 0/4 | `0568f95db049dccad254c672c2c8d284bbe6a586` | `c1810dd09dea69bdb2f00de498f62067528a6ec2` | True | True |
| 1/4 | `0568f95db049dccad254c672c2c8d284bbe6a586` | `c1810dd09dea69bdb2f00de498f62067528a6ec2` | True | True |
| 2/4 | `0568f95db049dccad254c672c2c8d284bbe6a586` | `c1810dd09dea69bdb2f00de498f62067528a6ec2` | True | True |
| 3/4 | `0568f95db049dccad254c672c2c8d284bbe6a586` | `c1810dd09dea69bdb2f00de498f62067528a6ec2` | True | True |

## Raw coverage

| Shard | Before measured IDs / images | After measured IDs / images | Skipped before / after | Failed before / after |
|---|---:|---:|---:|---:|
| 0/4 | 126 / 252 | 126 / 252 | 9 / 9 | 0 / 0 |
| 1/4 | 160 / 320 | 160 / 320 | 9 / 9 | 0 / 0 |
| 2/4 | 125 / 250 | 125 / 250 | 24 / 24 | 0 / 0 |
| 3/4 | 119 / 238 | 119 / 238 | 13 / 13 | 0 / 0 |

Downloaded coverage totals: before 530 measured IDs / 1060 images; after 530 IDs / 1060 images. These totals include unsteady views; declarations without measurements are not counted as captured views.

- before: declared without measurements ['LAY--detail']; incomplete widths {}; failed []; unmeasured [].
- after: declared without measurements ['LAY--detail']; incomplete widths {}; failed []; unmeasured [].
- One-sided raw screenshots: {"beforeOnly": [], "afterOnly": []}.
- Unsteady IDs recorded by CI: ['OVDV--root', 'PERP--tab-history'].
- Zero-view entries observed in completed job logs: ['ERN', 'EVTS', 'HDS', 'VIEW', 'debug-log'].

Observed zero-capture host exclusions: `ERN`: earnings-calendar is absent from the browser earnings composition (calls and ripple only); `EVTS`: earnings-calendar is absent from the browser earnings composition (calls and ripple only); `HDS`: holders is absent from the browser ownership composition; `VIEW`: custom-view is present in the full UI catalog but absent from the browser catalog; `debug-log`: debugPlugin is present in the full CLI catalog but absent from the browser catalog. Catalog exclusions must be checked against these compared refs; their prior diagnosis is not proof for this run. These entries are outside the measured browser coverage, not successful captures.

The selected owned Sweep entry closes the gallery on Enter. The audit detects changed pane text, record() returns false for the now-missing pane scope, and the caller still declares LAY--detail. Both sides have the same declaration without a detail measurement or image. LAY--root is measured at both widths. The current artifact text confirms the owned Sweep state, and relevant base/tested/submitted source blobs match. No original evidence was changed. Evidence: `ci-ui-lay-diagnostic.json`.

Declared-versus-actual identity audit: 12 captured view IDs resolve to a different pane on both sides. Official measured and changed totals remain untouched; these captures do not establish coverage of the declared pane. Evidence: `ci-ui-pane-identity-review.json`.
discover() first seeks the requested pane, but falls back to instances[0] if none matches (web-app.ts:234). ui-audit.ts:389 stores the requested token/paneId beside that returned instance, and uses the actual instance to render. A saved mismatch is a capture of another pane, not coverage of the declared pane. Symmetric mismatches with unchanged harness source predate these source changes; the exact command-resolution reason is not recovered from these artifacts.
Affected-task root identities: {"before": [{"token": "ALRT", "actual": "alerts", "declared": "alerts"}, {"token": "NOTE", "actual": "ticker-research", "declared": "quick-notes"}, {"token": "MOST", "actual": "ticker-research", "declared": "market-movers"}, {"token": "PL", "actual": "ticker-research", "declared": "plugin-marketplace"}], "after": [{"token": "ALRT", "actual": "alerts", "declared": "alerts"}, {"token": "NOTE", "actual": "ticker-research", "declared": "quick-notes"}, {"token": "MOST", "actual": "ticker-research", "declared": "market-movers"}, {"token": "PL", "actual": "ticker-research", "declared": "plugin-marketplace"}]}. Direct focused Marketplace fixtures separately exercise the intended pane and its removal failure states.

## Changed-view result

Official comparison: **1 of 530 views changed**; complete flag `True`.
Changed IDs: ['GP--root']. One-sided IDs: {'gone': [], 'new': []}. Pixel-comparison errors: [].
Stable compared views after unsteady exclusions: 528. A view counts as changed above 0.05% differing body pixels (ImageMagick 2% fuzz). Stable nonzero comparisons below that threshold: [{'view': 'CHOKE--root', 'width': '1280', 'fraction': 5.564769553072626e-05}, {'view': 'TAS--tab-nbbo', 'width': '1280', 'fraction': 2.5096019553072626e-05}]. Zero changed views does not imply every screenshot or pixel is identical.
The complete flag records shard completion. It does not certify catalog entries with zero captures or declarations with no measurement. Raw metadata and screenshots remain intact.

## Snapshot provenance and limits

Chromium, white theme, 640/1280px, one-level tab traversal; screenshot body comparison excludes 42px top and bottom.

Current cross-head catalog, audit and layout source proof: `../../followup-ci-ui-scope-source-provenance.json` (the exact refs are recorded inside that proof). The local `ci-ui-source-provenance.json` additionally verifies the c181 pair.

Restored cache keys: ui-audit-plugins-2026-43, ui-replay-v2-1of4-2026-43, ui-replay-v2-2of4-2026-43, ui-replay-v2-3of4-2026-43, ui-replay-v2-4of4-2026-43.
Artifacts preserve render measurements/screenshots and side revisions, but not the restored snapshot contents or plugin lock; cache provenance is evidenced by job logs and cache keys.
The offline snapshot does not exercise every authenticated or successful data state; missing snapshot reads can render the standard offline state. The one-level sweep intentionally skips deeper alternatives. No new UI rendering, tests, source changes or PR edits were performed by this audit.

Raw artifact ZIPs are preserved under `ci-ui-benchmark/`; each SHA-256 matches the GitHub artifact digest. Extracted originals, completed job logs, per-shard coverage and current run/artifact metadata are retained beside them. `ci-ui-review.json` contains the detailed audit.

## Retained exclusion review

PERP history is an excluded width-specific data-state mismatch: at 640px the baseline shows the replay error while the head shows funding metadata and a Pro history gate (6.2430% of body pixels differ); both 1280px images are byte-identical replay-error states. Nine relevant Perps/data/React/UI/browser/harness source objects are unchanged. Advancing clock-derived history queries and exact replay request keys are a plausible source-supported cause, but the actual request trace, clock and snapshot replies are not retained. Retry captures were deleted by the existing harness. Preserve the official exclusion; this does not establish stable history-state comparison coverage. OVDV root is also excluded: the original 640px JPEGs are byte-identical; at 1280px 780 body pixels (0.0851%) differ around canvas ATM/expiry labels. The retained originals show the settled surface with matching dates, and 11 relevant source objects are unchanged. The precise label-placement cause is unproven. Retry logs show an additional view, but their deleted images/results prevent reconstruction of that state. This exclusion also leaves the view without stable before/after comparison coverage.

Detailed original-image/source evidence: `ci-ui-unsteady-audit.json` and its individually hashed peer reviews.

## Changed GP view review

The official result remains 1 of 530 changed views, GP--root. The original chart difference is localized to the left price/volume edge: 1,115 body pixels (0.2433%) at 640px and 1,139 (0.1243%) at 1280px. Both complete image pairs are byte-for-byte reversed matches of the independent frozen-base→2458 run, which officially classified GP as unsteady. Eleven chart/data/UI/browser/harness source objects match across frozen base, c181 and 2458. This establishes an already-observed capture variation, while preserving the current run’s changed classification. The exact rendering/timing cause is unproven; deleted retry captures prevent reconstruction of why this run did not exclude it. Exact body fractions: 1,115/458,240 at 640px and 1,139/916,480 at 1280px. Source/archive-bound independent acceptance: `ci-ui-gp-root-acceptance.json`.
