import type { PaneReportOptionDef, PaneSettingsDef, TickerResearchTabProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import type { OptionsViewProps } from "./types";
import { OptionsView } from "./view";
import { isKnownMutualFund } from "../../../tickers/instrument-kind";
import { expirationOptionSeconds, expiryIsoDate, OPTION_EXPIRATION_FORMAT, OPTION_EXPIRATION_PLACEHOLDER, readOptionExpiration } from "../../../utils/option-expiry";

/** The registered chain shows IV rank; isolated view renders stay offline. */
function OptionsPane(props: OptionsViewProps) {
  return <OptionsView {...props} ivRank />;
}

/**
 * The research tab strip keeps h/l and the arrows, so the chain steps expiries
 * with [ and ]. It never claims the app's input capture: every app and pane
 * key keeps working while the chain has the cursor.
 */
function OptionsResearchTab({ width, height, focused }: TickerResearchTabProps) {
  return <OptionsView width={width} height={height} focused={focused} ivRank nestedInTabs />;
}
import {
  LIVE_STREAMING_QUICK_SETTING,
  withLiveStreamingSetting,
} from "../../../state/hooks/live-streaming";
import { OPTION_FIELD_DEFS, normalizeOptionColumnsOption, resolveOptionFieldIds } from "./table";
import {
  STRIKE_WINDOW_PRESETS,
  STRIKE_WINDOW_SETTING,
  normalizeStrikeWindowOption,
  resolveStrikeWindow,
  strikeWindowShortLabel,
  strikeWindowValue,
} from "./strike-window";

function optionsSettings(settings: Record<string, unknown>): PaneSettingsDef {
  const strikeWindow = resolveStrikeWindow(settings[STRIKE_WINDOW_SETTING]);
  const strikeWindowText = strikeWindowValue(strikeWindow);
  const strikeWindowOptions = STRIKE_WINDOW_PRESETS.map(({ value, label, description }) => ({ value, label, description }));
  return {
    title: "Options Settings",
    values: {
      optionColumnIds: resolveOptionFieldIds(settings.optionColumnIds),
      [STRIKE_WINDOW_SETTING]: strikeWindowText,
    },
    fields: [
      {
        key: STRIKE_WINDOW_SETTING,
        label: "Strikes",
        description: "Which strikes the chain lists: all of them, a count either side of the money, or those whose call or put delta falls in a band.",
        type: "select",
        // A window typed on the command line that no preset matches stays selectable.
        options: strikeWindowOptions.some((option) => option.value === strikeWindowText) ? strikeWindowOptions
          : [...strikeWindowOptions, { value: strikeWindowText, label: strikeWindowShortLabel(strikeWindow), description: "Set from the command line." }],
      },
      {
        key: "optionColumnIds",
        label: "Columns",
        description: "Choose and order the fields mirrored around the strike.",
        type: "ordered-multi-select",
        options: OPTION_FIELD_DEFS.map((field) => ({
          value: field.id,
          label: field.label,
          description: field.description,
        })),
      },
      {
        key: "chainRefreshMinutes",
        label: "Chain refresh",
        description: "How often the whole chain snapshot is refetched. Quotes for visible strikes stream separately.",
        type: "select",
        options: [
          { value: "1", label: "Every minute" },
          { value: "5", label: "Every 5 minutes" },
          { value: "10", label: "Every 10 minutes" },
          { value: "30", label: "Every 30 minutes" },
        ],
      },
    ],
  };
}

/** `fn OMON AAPL --expiration 2028-01-21`: the expiry the chain opens at, as the pane setting a handoff sets. */
const EXPIRATION_REPORT_OPTION: PaneReportOptionDef = {
  key: "expiration",
  type: "string",
  placeholder: OPTION_EXPIRATION_PLACEHOLDER,
  description: `The expiry to show, as ${OPTION_EXPIRATION_FORMAT}. Without it, the nearest one.`,
  example: "--expiration 2028-01-21",
  normalize: (value) => expiryIsoDate(expirationOptionSeconds(value)),
};

export const optionsModule: PluginModule = {
  panes: [
    {
      id: "options",
      name: "Options",
      icon: "O",
      component: OptionsPane,
      defaultPosition: "right",
      tickerFollower: true,
      defaultMode: "floating",
      defaultFloatingSize: { width: 112, height: 28 },
      quickSettings: [LIVE_STREAMING_QUICK_SETTING],
      settings: (context) => withLiveStreamingSetting(optionsSettings(context.settings), context.settings),
      tableExport: true,
      reportOptions: [EXPIRATION_REPORT_OPTION, {
        key: STRIKE_WINDOW_SETTING,
        aliases: ["delta"],
        type: "string",
        placeholder: "all|count|delta band",
        description: "Strikes to list: all (the default), a count either side of the money such as 10, "
          + "or a call or put delta band such as 0.70-0.90. --delta 0.70-0.90 reads the same",
        example: "--strikes 0.70-0.90",
        normalize: normalizeStrikeWindowOption,
      }, {
        key: "columns",
        settingKey: "optionColumnIds",
        type: "string",
        placeholder: "fields",
        description: `Fields mirrored around the strike, in order, as the Columns setting picks them: ${OPTION_FIELD_DEFS.map((field) => field.id).join(", ")}`,
        example: "--columns bid,ask,spread,delta,openInterest,extrinsicPerYear",
        normalize: normalizeOptionColumnsOption,
      }],
    },
  ],

  paneTemplates: [
    createTickerSurfacePaneTemplate({
      id: "options-pane",
      paneId: "options",
      label: "Options",
      description: "Options chain for the selected ticker.",
      keywords: ["options", "chain", "calls", "puts", "omon"],
      shortcut: "OMON",
      settings: (_symbol, _context, options) => {
        const expiration = readOptionExpiration(options?.values?.expiration);
        return expiration == null ? {} : { expiration, expirationTargetKey: null };
      },
      publicShare: true,
    }),
  ],

  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "options",
      name: "Options",
      order: 35,
      component: OptionsResearchTab,
      instruments: ["equity", "fund", "index", "future", "option"],
      isVisible: ({ ticker, financials, hasOptionsChain }) => hasOptionsChain && !isKnownMutualFund(ticker, financials),
    });
  },
};
