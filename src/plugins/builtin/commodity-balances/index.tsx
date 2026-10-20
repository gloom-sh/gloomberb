import type { PluginModule } from "../plugin-module";
import { commandRequestParams } from "../shared/command-tab";
import { commodityBalancesHeadless } from "./headless";
import { PSD_CROPS, psdCrop, unknownCropMessage } from "./model";
import { CommodityBalancesPane } from "./pane";

export const commodityBalancesModule: PluginModule = {
  panes: [
    {
      id: "commodity-balances",
      name: "Crop Balances",
      icon: "B",
      component: CommodityBalancesPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 108, height: 28 },
      tableExport: true,
      headless: commodityBalancesHeadless,
    },
  ],

  paneTemplates: [
    {
      id: "commodity-balances-pane",
      paneId: "commodity-balances",
      label: "Crop Balances",
      description: "World balances for wheat, corn, soybeans, cotton, coffee and sugar, with season-average price forecasts when a table is published.",
      keywords: ["wheat", "corn", "soybeans", "cotton", "coffee", "sugar", "crop", "balances", "production", "exports", "stocks", "harvest"],
      shortcut: {
        prefix: "PSD",
        argKind: "text",
        argPlaceholder: "crop",
        argOptional: true,
        openWithoutArg: true,
        argOptions: () => PSD_CROPS.map((crop) => ({ value: crop.toLowerCase(), label: crop })),
      },
      headless: commodityBalancesHeadless,
      // PSD coffee opens the board at coffee's first row.
      createInstance: (_context, options) => {
        const typed = options?.arg?.trim();
        const crop = typed ? psdCrop(typed) : null;
        if (typed && !crop) throw new Error(unknownCropMessage(typed));
        return { placement: "floating", ...(crop ? { params: commandRequestParams({ crop }) } : {}) };
      },
    },
  ],
};
