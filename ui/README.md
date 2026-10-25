# UI benchmark captures

**Capture coverage is incomplete.** Verified matched variants are retained; missing or excluded variants are listed in the [partial coverage report](partial-coverage.md) and do not count as unchanged.

Base `5ce0c7c5a`, head `b696464db`. **0 of 562 views changed** in the standard benchmark. Both dark and light captures were also compared at 640 and 1280 px.

| Theme | Width | Paired views | Before/after captures |
|---|---:|---:|---|
| Dark | 640 px | 552 | [28 sheets](dark-640.md) |
| Dark | 1280 px | 540 | [27 sheets](dark-1280.md) |
| Light | 640 px | 552 | [28 sheets](light-640.md) |
| Light | 1280 px | 515 | [26 sheets](light-1280.md) |

[Find a view](views.md) · [Native-resolution examples](native.md) · [Publication review](publication-privacy-summary.md)

Both revisions use the same offline data and the same pane inputs. The comparison uses the standard pane-body crop and pixel threshold. Corrected capture fixtures are applied to both revisions; original evidence is retained locally.

CHAT captures use invented demo messages and names, identical on both revisions. Original captures are retained locally for the unchanged-data comparison.

The combined comparison contains 2159 paired size/theme variants. 1788 have byte-identical full-frame images; 2157 pass the standard pane-body pixel threshold. These counts cover only retained pairs.

The original browser sweep anchors its replay clock at 2026-10-18 and advances it with elapsed capture time. Targeted clock corrections are described with their affected captures in the partial coverage report.

The standard benchmark excludes 2 views from its change count after repeat captures demonstrated variation within the same revision. The exact affected sizes and themes are listed in the [rendering variability report](rendering-variability.md).

Coverage: all 182 catalog entries were attempted on both revisions. 10 entries have incomplete or unsupported browser coverage and are excluded as whole pairs. They are not counted as unchanged. See the [coverage gaps](coverage.md).

Controlled-state coverage: HILO, FLOW. These captures verify the same documented offline state on both revisions; they do not verify loaded live data.

Empty-query coverage: twitter-feed-pane. Loaded search results are outside these captures.

Account-root coverage: team-pane. Signed-in team content is outside these captures.

Small content fields are masked in public copies. The comparisons use the unmodified originals.
