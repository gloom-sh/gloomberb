import type { PluginModule } from "../plugin-module";
import { rotationCache } from "./client";
import { rotationHeadless } from "./headless";
import { RelativeRotationPane } from "./pane";

export const relativeRotationModule: PluginModule = {
  panes: [
    {
      id: "relative-rotation",
      name: "Relative Rotation",
      icon: "R",
      component: RelativeRotationPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 36 },
      tableExport: true,
      headless: rotationHeadless,
      settings: {
        title: "Relative Rotation",
        fields: [
          {
            key: "scope",
            label: "Universe",
            type: "select",
            options: [
              { value: "sectors", label: "US sectors" },
              { value: "collection", label: "Linked watchlist or portfolio" },
              { value: "custom", label: "Custom symbols" },
            ],
          },
          {
            key: "symbols",
            label: "Custom symbols",
            type: "text",
            placeholder: "AAPL:NASDAQ, MSFT:NASDAQ",
          },
          {
            key: "benchmark",
            label: "Benchmark",
            type: "text",
            placeholder: "SPY:NYSEARCA",
          },
          {
            key: "trail",
            label: "Trail weeks",
            type: "select",
            options: Array.from({ length: 11 }, (_, index) => index + 2).map(
              (value) => ({
                value: String(value),
                label: String(value),
              }),
            ),
          },
        ],
      },
    },
  ],
  paneTemplates: ["RRG", "GRR"].map((prefix) => ({
    id: `relative-rotation-${prefix.toLowerCase()}`,
    paneId: "relative-rotation",
    label: "Relative Rotation",
    description:
      "Sector or watchlist strength and momentum versus a benchmark, with weekly trails.",
    keywords: [
      "relative",
      "rotation",
      "strength",
      "momentum",
      "sector",
      prefix.toLowerCase(),
    ],
    shortcut: { prefix, argKind: "ticker-list" as const, argOptional: true },
    headless: rotationHeadless,
    createInstance: (_context, options) => ({
      settings: options?.symbols?.length
        ? { scope: "custom", symbols: options.symbols.join(",") }
        : { scope: "sectors" },
      placement: "floating" as const,
    }),
  })),
  setup(ctx) {
    rotationCache.attach(ctx.persistence);
  },
  dispose() {
    rotationCache.reset();
  },
};
