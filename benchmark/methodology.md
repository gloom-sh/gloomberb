This audit uses the repository's capture measurements, pixel comparator, token checks and report stages, resumed through bounded external orchestration. It is not a successful unmodified top-level `ui:benchmark` invocation.

The source revisions are `5ce0c7c5a08ec2eabc738a6789d5e8d9e9c80db4` and `5082af5ad9a787647561a868b97b15866c6b22e2`. The reused web bundles contain 224 files each. Their SHA-256 manifest hashes are `04afcd7d132937267776605e1805606709e3960626d78f0e6205cd5532a3c4b1` and `da4a2fa3594fc324035f116f0a0e63172492d45d41059e4e3e4fffb1e0cc8cdb`. The command sweep uses the same pinned Chromium, fonts, viewport settings and offline replay on both sides. Target and complementary fixture families use separate synthetic data and clocks, matched before/after within each family. Existing captures retain their original runtime provenance; resumed orchestration pins Bun 1.3.11.

Command discovery waits for the app header, command input, exact submitted query and expected pane identity. Commands without shortcuts use their actual display labels; X Feed uses its native shortcut, AI gets an explicit text query, and the price chart uses AAPL. Portfolio and watchlist collection IDs are checked. The AI Screener route submits its explicit configuration form and verifies the saved prompt. The T research alias verifies its exact submitted shortcut feedback before asserting persisted pane identity. OVDV repairs and affected HVG repeats wait up to 60 seconds for their expiry/ATM-IV loading footer to clear, on both revisions and corresponding repeat captures; other panes retain their existing settling timings. Failed commands do not silently become bare pane instances. Settling repairs replace identified incomplete or semantically incorrect captures, retaining the originals and reasons.

The runtime inventory contains 169 browser command entries: 150 built-in entries, 11 registry representatives and 8 shell views. Fifteen complementary fixtures cover the 12 browser omissions plus Story, Team and the trading console. The trading-console template requires a configured Gateway profile, so its unconfigured pane is captured explicitly. The audit’s extra-plugin build deliberately permits desktop-only plugins; target metadata alone does not establish browser availability. The complementary pictures exercise the pane-body DOM renderer, not a native desktop shell. The debug pane is terminal/CLI coverage through that renderer, not shipped desktop coverage. Screenshot mode omits some action and chart controls. Signed-out, offline, empty and setup states do not verify authenticated or populated interiors.

The command sweep uses the native white-theme settings at 640 and 1280 pixels. The target watchlist and complementary fixtures also have dark and light before/after pictures at both widths. The native pixel comparison uses absolute error with 2% fuzz, a changed-view threshold of 0.0005, and the original 42-pixel top and bottom insets. Byte-identical images bypass ImageMagick only for the AE metric; all other results cache the exact native comparison arguments and file content hashes, checked against native output on an identical and a differing target pair. Complementary fixtures compare the whole image and flag every nonzero difference.

Native Enter measurements include real focus changes, dialogs, editing and navigation, as well as stack details. The futures captures originally withdrawn as loading-only were restored after focus-loss evidence showed a mixed interaction and asynchronous quote transition. The confirmed loading-only fundamental-chart capture remains archived. The async-only OVDV expiry-loading transition is also archived; its root was subsequently repeated and reviewed as same-code chart variation. LAY Enter activates an empty layout and removes the source pane, so its absent source measurement is listed as skipped while navigation diagnostics remain. RV Enter opens a focused AAPL research pane at both widths; its source text changes only at640. The narrow repair recognizes that proven navigation, includes it in the screenshot, and explicitly keeps measurements scoped to the source RV pane. New records include versioned destination/overlay/focus state; generated instance IDs do not decide equality. Older captures without that metadata do not retrospectively gain semantic navigation verification. Table expansion still needs its row measurements; compact interaction metadata alone cannot prove it.

Native final exits, exact view counts, missing/skipped states, instability evidence and token results are reported in the companion summary. A same-code repeat is evidence about that captured state only. Unresolved or unrepeatable states cannot be described as unchanged. The native headline denominator includes excluded unstable views; its stable subset must be stated separately. Family sheets use White Phosphor at 1280px, include up to 16 moved or error views plus 4 unchanged references per family, and do not apply the native headline's unstable-view exclusions. The target and complementary fixtures use matched data only within their own families: BR/ORD use a synthetic demo broker, account and orders; Story uses invented persisted content; Team shows signed-out state only; the trading console uses its exact pinned plugin bundle with no configured broker profiles/accounts/portfolios. Cache directory digests are opaque provenance keys, not a claim that runtime or source versions are identical. The successful native stages and observed exits are listed individually. Semantic signature matching is enforced only for repeated detail captures; root/tab sidecar labels are diagnostic and do not establish signature equality.

Two complementary images initially failed before rendering when Chrome DevTools startup timed out. Their original records remain archived. Explicit retry mode checks exact fixture identities and source revisions, retries only those failed keys serially, and verifies all 118 successful PNG hashes remain unchanged. The original capture runner’s nonzero exit is retained; continuation stage exits are reported separately.

The final targeted TypeScript 5.9.2 semantic check passed with zero diagnostics across six helper roots and their 1004-file import graph (2.46 seconds, approximately 515 MiB). Initial diagnostics and previous checks are retained separately. This check does not validate generated JavaScript strings or runtime DOM behavior. A browser-free AI discovery branch check exercised native click calls and saved-config/prompt assertions. Python continuation wrappers were parsed without executing browser work before launch.

Contact-sheet generation initially failed because its requested label font was unavailable; all 60 native image comparisons had already returned zero changed pixels under the native comparator (2% fuzz), without errors. The sheet-only continuation uses an explicit installed label font and checks that all 120 PNG hashes stay unchanged. Native report labels use isolated aliases for the installed exact JetBrains Mono Regular file. Browser fonts and captured pixels are unaffected by reporting configuration.

Frozen capture/post-capture helper manifest SHA-256: `6ea30f027996ce44a2130cbe5c85615012a0f2c21fd31f7e12ffeb37e11478f0`. Existing records retain the helper versions under which they were captured. Frozen helper hashes:

| Helper | SHA-256 |
|---|---|
| `native-audit-ready.ts` | `b26c4029eb6d10982f4b56b3aabe9b052883d70aef6269da5e39cd9f59ec7b04` |
| `native-web-ready.ts` | `ae4158bf79e1771eedef89b7a08478022f59b7b747c3dcfd9fa4140f1d9cf52b` |
| `native-tabs.ts` | `dd59b8508b0f5f529b2147e165ae7eb9d4e3a0b2210fb80dcd1612c72c923430` |
| `interaction-state.ts` | `c3dd0310f22bbdf2bdf8d8c4c4b25f123a51ec289c9afb15ca8ef0de29fff257` |
| `repeat-views.ts` | `5e7015b6403c462f5d51e2704a9f10af1980a77f0ca957738ac6e741aa0eab90` |
| `run-audit-batch.py` | `9701639f8f1908c677ef300552f4285cd9da8ee5fb8658ac730b534dc4e54fdb` |
| `next-batch.py` | `765cb6d7d3f9f3c8a936c054880c8e4fb938d36907a5504c2ccba351445dc412` |
| `width-repairs.json` | `45d36597a17510021f896f1e6ecab892f2294b696f6d0bdfa020a93039357ff1` |
| `validate-coverage.py` | `deafd9360994dd2ea2dd441b0686137c81f60cb5508e9a9e0862fd9d4f5f5ad8` |
| `post-capture.py` | `1b4c250f20bf21f15c4bbf3cc611c8457c93d825e2a0e253aba6ab14a05e96bd` |
| `post-capture-diff.ts` | `ba36b033b54f63659a2985167e9a34142fd04fa6ef9a2cd201620a762e85aee2` |
| `native-benchmark.ts` | `f8c4c63d710e48ac125cc83e61fcad94f04d0bc3d2b10c38e97a258e170bb894` |
| `capture-state-inventory.py` | `5a606932701faa2ee39a6eb16c52b90beacec1759e26f58953d00ded00648636` |
| `owned-processes.py` | `2deb0a589f5afbef29d013044f27ab2643c5dc9b19874aa25bead1c11009f834` |
| `final-review-under-lock.py` | `d0459a26e17a7232e4ec35534bd36dde51abb64cdd47484a894927b19dba9dad` |
| `run-final-report.py` | `9a80a2b0e86cc0bec26dd76e96e1a60e8df4879b959fa85679239371198c89e8` |
| `report-tools/bun` | `d85499b02a3c72d8289d28987373f057d6b10694603e92dbb45e3b071c9c79fb` |
| `image-tools/compare` | `767970d973bd3ddfb4dd02dd234bc9df75b9a50b339fcb828beec73b779f9116` |
| `supplemental-command.json` | `dd2bc7926be3a902437740333832bbfd855ed551acdfe092d71f598c0cf89963` |
| `public_assets.py` | `25b79f36a3d35581a467675f445a95c260ba9b6f6044a3c0fe57b07bf5d48061` |
| `scan-public.py` | `f9af0ad7d971904f94751b0144fd43e7d24247400e6c0c1578d8870e498e4479` |
| `publish-evidence.py` | `be86adcfdef03670df51a7611ea9f8fe043bb6141683878d6a9d0adc3721ca74` |
| `catalog.tsv` | `800d5c61800d13f937933063484da82973293771b146c88a144fe1eec3ee4be6` |
| `catalog-capture-scope.json` | `144e44b6f15b3d7fba7e965c93902dc95a1cf2cdf6b58c87467cefb2c10f441d` |
| `complementary/run.py` | `de0562d4a35b460478b1fd84c0c2fe9cebd3fb12e63344c6de65e80028cca797` |
| `complementary/compare-and-sheet.py` | `436cbfa796ff65aacd808cdf292ae2aeb9bcb50783d660c94274479ab68d1c73` |
| `ai-submit-dry-run.ts` | `92e214de4ba7792e9ccbf6094beaca8d23c15dc2e2427fa1055e9e1164fa2df9` |
| `helper-typecheck.cjs` | `c0a0e31a49f69b43621826deb1e01b2e23b76cb0ba30a726f0a9f1067678956b` |
| `late-guide-and-supplemental.py` | `cd611ef5a5d1d648ef0dc528abd4c2bef61323c1d7870c8d7b974027879fd913` |
| `supplemental-original-command.json` | `676dba51d1ee42aa3e608597c53614a4e11fb9c162a2c20655f819ec623f4299` |
| `complementary/capture-worker.ts` | `7bd03abb8e414aa0250762c8ab7f653972e3fac3a56775ec5ea52535c17216c6` |
| `complementary/plugin-fixtures.json` | `cd203afbe062f1d8b8b50c210e5cb27f5fcac250fa6efd7223ce43e9ed81f6a7` |
| `retry-supplemental-and-finish.py` | `af5553e8dff6fc09473d11f8fa6cbb0b64a2708ee6751df580bbaa94712e1bec` |
| `resheets-and-finish.py` | `38dfcf0a5fc58d9be574717a889c32db1123ee1af17fedd933e34a7b6ad97575` |
| `report-fonts/type.xml` | `f27ce1cbaad9143ffeb6ad5976410cd97a7a9efa088562e5f7a7ba130c270fae` |
| `report-fonts/provenance.json` | `8c04b3cdd2df13a03d66364a6de2c6b7d29a3a14da520b7eb604e9c8589db973` |

Final review added four-way original/repeat sheets and native paired-repeat comparisons at all 23 originally moving widths. Seventeen widths fell below the native change threshold; six remain variable and are explicitly excluded from unchanged claims. The first review montage returned zero despite missing label-font warnings; its sheets were regenerated with the installed font and warnings treated as errors, without repeating comparisons or changing source captures. The earlier frozen manifest describes capture/post-capture helpers; review-only helpers and publication selection were subsequently added.

Review/publication helper SHA-256 values (added after the frozen capture manifest):

| Helper | SHA-256 |
|---|---|
| `paired-repeat-review.ts` | `bcd0cfed57eaf43391d15a74c08feba7597f907ea9fdef6586edb045a6053394` |
| `paired-repeat-review.py` | `09bf966f206e432910880e78b007b96b677af7cc0f73be5189740b674c10fea0` |
| `paired-repeat-resheets.py` | `c74c8f7447315908f2ed9275405966cab294b79dfbcca3ef696b17947fa0d63d` |
| `prepare-public-and-scan.py` | `857bd1cbd2699a6f5df0c4b9bfbc18a32908d20f0939824bf1f39337a3a85ca8` |
| `public_assets.py` | `7e950124669e015b9988dc408f9feeee581cf67eaa74938be9d141ba41c3406a` |

Publication OCR scans all selected pictures. One whole-sheet sparse OCR call took several minutes; completed results were retained. Subsequent large-sheet calls use 1280px tiles overlapping by 256px, at most three OCR workers, and a 45-second limit per tile. The report-only wrapper caches results by original image hash and records each tile exit. Any interrupted or timed-out scan is preserved separately and retried only for that failed image; success is required for publication. The original published image bytes are unchanged. Final text/metadata checks and an artifact hash manifest are verified before pushing.

Final OCR helper SHA-256: `2527b1de90dc86bfbce1c2aeff6ba191d869d9d64752de617433fbe51a1ad54c`. Final publication-review helper SHA-256: `2c012d2d3fb07cac6f8d14a5e6e88ce0757cb7a1a589d11abd7c19b497692a92`.
