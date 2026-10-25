# All-pane UI benchmark

Native headline: **0 of 568 views changed**, after excluding 17 variable views. The more precise result is **0 of 551 stable views exceeded the native change threshold**. The raw comparison had 17 moving views. Same-code repeats, matching configuration metadata and image review support loading/enrichment or chart-render variation for those 17; they are not asserted unchanged. Six of 23 paired-repeat widths remain above threshold. See the [stability review and four-way sheets](stability.md).

Base: `5ce0c7c5a08ec2eabc738a6789d5e8d9e9c80db4`. Head: `5082af5ad9a787647561a868b97b15866c6b22e2`.

| Coverage or check | Result |
|---|---|
| Command entries | 169 per side: 150 built-in, 11 registry representatives, 8 shell views |
| Measured views | 568 per side, identical ID sets |
| Measured widths | 640 and 1280px; 1,136 records per side, 2,272 total |
| Missing/new views or comparison errors | 0 |
| Skipped nested states | 73 per side; excluded from measured coverage |
| Stable changed views | 0 of 551 above threshold |
| Variable views | 17 excluded after review |
| Complementary pane-body fixtures | 15 entries, 120 pictures, 60 before/after pairs |
| Complementary comparison | All 60 pairs returned zero changed pixels under the native comparator (2% fuzz) |
| UI token check | Exit 0 |
| Native report | Exit 0, 2 of 2 shards complete |
| Native family-report child | Exit 0, independently observed |

The command comparison uses Chromium, White Phosphor, AE with 2% fuzz, a changed-view threshold of 0.0005, and the original 42px top/bottom insets. The 15 complementary fixtures cover browser omissions plus Story, Team and the unconfigured trading console, bringing catalog coverage to 184 entries. Their [four sheets](complementary) show dark and light at both widths; their comparisons cover the full image. The [targeted watchlist before/after pictures](../README.md) separately exercise deferred and continuous futures with matched synthetic data. The command sweep's watchlist fixture contains stocks and crypto.

Native changed-view sheets are absent because no stable view moved above threshold. The native [family sheets](families) retain the 17 raw movements and unchanged reference views at 1280px; they do not apply the headline's unstable exclusions. There are 23 family sheets. Their labels reflect raw comparison results; the stability review explains exclusions.

This was a resumed native-stage sweep with documented external orchestration, not a successful unmodified top-level benchmark invocation. Capture discovery/readiness repairs, archived failures, exact bundles, runtime provenance, report-font configuration and helper checks are in [methodology](methodology.md).

Verification limits: skipped nested states, signed-out/setup/empty views and some screenshot-mode controls are not covered beyond their pictured state. Authenticated interiors and a native desktop-shell launch were not exercised. Legacy interaction records without destination metadata remain semantically unverified. Six variable paired-repeat widths remain above threshold. No measured state is silently counted unchanged because capture or comparison failed.

The overall verification is not all green. The locked terminal navigation gate and 120-ticker memory limit passed, with substantial shared-host timing noise. The locked DOM drag/resize comparison failed the absolute 24px pointer-lag budget in eight scenarios; three also failed on main, while five were not established as pre-existing. A complete locked pointer sweep was not completed. See [DOM validation](dom-validation.md), [drag/resize results](pane-drag.md) and [terminal performance](../terminal/performance.md).
