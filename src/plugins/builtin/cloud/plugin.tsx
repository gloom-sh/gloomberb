import type { GloomPlugin } from "../../../types/plugin";
import { apiClient } from "../../../api-client";
import { createGloomberbCloudCapabilities, createGloomberbCloudProvider } from "../../../sources/gloomberb-cloud";
import { accountManagementModule } from "../account-management";
import { chatModule } from "../chat";
import {
  CONGRESS_TRADES_PANE_ID,
  CongressPane,
} from "../congress-trades/pane";
import { congressHeadless } from "../congress-trades/headless";
import { cloudTweetsModule } from "../cloud-tweets";
import { composeBuiltinPlugin, type PluginModule } from "../plugin-module";
import { askgConversationListStore } from "./askg/conversation-store";
import { ASKG_PANE_ID, ASKGPane } from "./askg/pane";
import { askGloomQuestion } from "./askg/pending-question";
import { registerCloudAuthCommands } from "./auth-commands";
import { registerCloudUpgradeCommand } from "./upgrade-command";
import { CloudUpgradeStatusWidget } from "./upgrade-status-widget";
import { registerTrialOfferCommand, TrialOfferStatusWidget } from "./trial-offer-status-widget";
import { CloudVerificationStatusWidget } from "./verification-status-widget";
import { createPublicPaneShare } from "../shared/public-pane";
import { teamModule } from "./team/module";
import { thesisModule } from "./thesis/module";

function createCloudDataModule(): PluginModule {
  return {
    capabilities: createGloomberbCloudCapabilities(createGloomberbCloudProvider()),
    setup(ctx) {
      ctx.registerSyncTransport({
        id: "gloomberb-cloud",
        isAvailable: () => apiClient.isVerified(),
        pullSnapshot: () => apiClient.getSyncSnapshot(),
        pushSnapshot: (snapshot, options) => apiClient.putSyncSnapshot(snapshot, options),
      });
    },
    dispose() {
      apiClient.dispose();
    },
  };
}

/** Sign-in and upgrade commands, and the email verification, upgrade and trial prompts. */
const cloudAccountModule: PluginModule = {
  slots: {
    "status:widget": () => (
      <>
        <CloudVerificationStatusWidget />
        <CloudUpgradeStatusWidget />
        <TrialOfferStatusWidget />
      </>
    ),
  },
  setup: (ctx) => {
    registerCloudAuthCommands(ctx);
    registerCloudUpgradeCommand(ctx);
    registerTrialOfferCommand(ctx);
  },
};

const askgModule: PluginModule = {
  setup(ctx) {
    // Only the dragged sidebar width is per device; the conversations
    // themselves belong to the account and are read from the cloud.
    askgConversationListStore.attach(ctx.persistence);
  },
  panes: [{
    id: ASKG_PANE_ID,
    name: "Ask Gloom",
    icon: "K",
    component: ASKGPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 96, height: 32 },
    portableShare: {
      // A conversation and the panes it read are personal to the account.
      private: { title: true, params: true, settings: true, state: true },
    },
  }],
  paneTemplates: [{
    id: "askg-pane",
    paneId: ASKG_PANE_ID,
    label: "Ask Gloom",
    description: "Ask a question about your panes and watch the tools Gloom runs",
    keywords: ["ask", "gloom", "assistant", "ai", "question", "askg"],
    shortcut: { prefix: "ASKG", argPlaceholder: "question", argKind: "text" },
    createInstance: (_context, options) => {
      // The question is handed to the pane directly, so it is never persisted
      // with the layout and never replayed on the next launch.
      askGloomQuestion(options?.arg ?? "");
      // One assistant: a second question focuses the conversation already open
      // and asks there instead of stacking another pane.
      return { placement: "floating", instanceId: "askg:main" };
    },
  }],
};

const congressTradesModule: PluginModule = {
  panes: [{
    id: CONGRESS_TRADES_PANE_ID,
    name: "Congress",
    icon: "G",
    component: CongressPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 112, height: 30 },
    tableExport: true,
  }],
  paneTemplates: [{
    id: "congress-trades-pane",
    paneId: CONGRESS_TRADES_PANE_ID,
    label: "Congress Trades",
    description: "Track newly disclosed House and Senate periodic transaction reports.",
    keywords: ["congress", "house", "senate", "trades", "ptr", "stock", "disclosures"],
    shortcut: { prefix: "CG", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
    headless: congressHeadless,
    createInstance: (_context, options) => {
      const symbol = (options?.symbol ?? options?.arg)?.trim().toUpperCase();
      return symbol
        ? { instanceId: `${CONGRESS_TRADES_PANE_ID}:${symbol}`, title: `Congress ${symbol}`, placement: "floating", settings: { ticker: symbol } }
        : { placement: "floating" };
    },
    publicShare: createPublicPaneShare("Congress Trades"),
  }],
};

/** The desktop and browser builds differ only in the modules they add here. */
export function createGloomberbCloudPlugin(extraModules: readonly PluginModule[] = []): GloomPlugin {
  return composeBuiltinPlugin({
    id: "gloomberb-cloud",
    name: "Gloom Cloud",
    version: "1.0.0",
    description: "Free market, macro, and chat services. Chat requires signup.",
    toggleable: true,
    order: 10,
    modules: [
      createCloudDataModule(),
      chatModule,
      teamModule,
      thesisModule,
      accountManagementModule,
      cloudAccountModule,
      askgModule,
      ...extraModules,
      congressTradesModule,
      cloudTweetsModule,
    ],
  });
}
