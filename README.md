# GLO-1081 review images

Source head: `67ba3db20b35655d21f36c772baa80fdde272a83`. Frozen baseline: `f3b98364755ed9039d3d7becc98e81732a7a4571`.

The primary `desktop-pane-*-labeled.png` sheets show two actual Notes panes in the shared pane frame and toast hosts. Baseline is above head. The left pane is the export case under test; the right pane stays in the existing unreadable-body export-error state. All eight comparisons have zero changed pixels across the entire neighboring Notes pane. Pane content is fixed invented quick-note state corresponding to the file scenarios; notices come from the real registered Export Notes action on invented files. These are component fixtures, not the full desktop shell or execution through Electrobun transport. `pane-provenance.json` and `pane-comparisons.json` document source identities, capture scope and comparisons.

The other twelve labeled sheets are supplementary isolated shared-toast fixtures. They do not picture pane bodies. Desktop places the affected result on the left and unchanged error result on the right. Terminal places the unchanged error notice above the affected notice. The original raw-derived unlabeled sheets remain here for provenance; labels were added outside unchanged source images.

White and paper themes, narrow and wide desktop views, plus terminal toast captures. Offline synthetic fixtures, no credentials or external request attempts in these focused captures. These pictures supplement the separately recorded all-pane UI benchmark.
