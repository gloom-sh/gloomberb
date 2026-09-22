import type { PluginModule } from "../plugin-module";
import {
  OPTIONS_CALCULATOR_PANE_ID,
  OPTIONS_CALCULATOR_TEMPLATE_ID,
} from "./model";
import { OptionsCalculatorPane } from "./pane";
import { optionsCalculatorHeadless } from "./headless";

export const optionsCalculatorModule: PluginModule = {
  panes: [
    {
      id: OPTIONS_CALCULATOR_PANE_ID,
      name: "Options Calculator",
      icon: "V",
      component: OptionsCalculatorPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 96, height: 28 },
      headless: optionsCalculatorHeadless,
    },
  ],

  paneTemplates: [
    {
      id: OPTIONS_CALCULATOR_TEMPLATE_ID,
      paneId: OPTIONS_CALCULATOR_PANE_ID,
      label: "Options Calculator",
      description: "European Black-Scholes or American CRR value, Greeks, implied volatility and cash dividends.",
      keywords: ["option", "options", "calculator", "black", "scholes", "binomial", "american", "dividends", "greeks", "implied", "volatility", "ovme"],
      shortcut: { prefix: "OVME" },
      createInstance: (_context, options) => ({
        params: options?.values ?? {},
        placement: "floating",
      }),
    },
  ],
};
