/** @jsxImportSource react */
import type { CSSProperties } from "react";
import type { DockLayoutNode, PaneInstanceConfig } from "../../types/config";
import type { LayoutMarketplaceEntry } from "../../layout-marketplace/payload";

const PANE_NAMES: Record<string, string> = {
  "chart-composer": "Chart",
  "credit-conditions": "Credit Spreads",
  "earnings-calendar": "Earnings Calendar",
  "fx-matrix": "FX Cross Rates",
  "kelly-sizer": "Position Sizer",
  "market-halts": "Market Halts",
  "market-heatmap": "Market Heatmap",
  "news-breaking": "Breaking News",
  "news-feed": "News Feed",
  "news-industry": "Sector News",
  "news-top": "Top News",
  "options-calculator": "Options Calculator",
  "portfolio-list": "Portfolio",
  "prediction-markets": "Prediction Markets",
  "quick-notes": "Notes",
  sec: "SEC",
  "thirteenf-funds": "13F Funds",
  "ticker-news": "Ticker News",
  "ticker-research": "Ticker Research",
  "twitter-feed": "X Feed",
  "volatility-term-structure": "VIX Term Structure",
  "world-indices": "World Indices",
};

export function marketplacePaneName(paneId: string): string {
  return PANE_NAMES[paneId] ?? paneId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function paneSubtitle(pane: PaneInstanceConfig): string | null {
  if (pane.binding?.kind === "fixed") return pane.binding.symbol;
  const query = pane.params?.query;
  return query?.trim() ? query.trim().slice(0, 80) : null;
}

function PaneCard({ pane }: { pane: PaneInstanceConfig | undefined }) {
  if (!pane) return <div className="layout-pane missing">Unavailable pane</div>;
  const subtitle = paneSubtitle(pane);
  return (
    <div className="layout-pane">
      <strong>{pane.title?.trim() || marketplacePaneName(pane.paneId)}</strong>
      {subtitle ? <span>{subtitle}</span> : null}
    </div>
  );
}

function DockPreview({
  node,
  panes,
}: {
  node: DockLayoutNode;
  panes: ReadonlyMap<string, PaneInstanceConfig>;
}) {
  if (node.kind === "pane") return <PaneCard pane={panes.get(node.instanceId)} />;
  const firstStyle = { "--share-ratio": node.ratio } as CSSProperties;
  const secondStyle = { "--share-ratio": 1 - node.ratio } as CSSProperties;
  return (
    <div className={`layout-split ${node.axis}`}>
      <div className="layout-split-child" style={firstStyle}>
        <DockPreview node={node.first} panes={panes} />
      </div>
      <div className="layout-split-child" style={secondStyle}>
        <DockPreview node={node.second} panes={panes} />
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function LayoutShareView({
  entry,
  openLiveUrl,
}: {
  entry: LayoutMarketplaceEntry;
  openLiveUrl: string;
}) {
  const panes = new Map(entry.layout.instances.map((pane) => [pane.instanceId, pane]));
  const docked = new Set<string>();
  const collect = (node: DockLayoutNode | null) => {
    if (!node) return;
    if (node.kind === "pane") {
      docked.add(node.instanceId);
      return;
    }
    collect(node.first);
    collect(node.second);
  };
  collect(entry.layout.dockRoot);
  const extra = entry.layout.instances.filter((pane) => !docked.has(pane.instanceId));
  const author = entry.author.username ? `@${entry.author.username}` : entry.author.displayName;
  const date = formatDate(entry.publishedAt);

  return (
    <main className="layout-share wide">
      <header>
        <p className="eyebrow">Shared via Gloomberb</p>
        <h1>{entry.name}</h1>
        <p className="layout-meta">{[author, date, `${entry.layout.instances.length} panes`].filter(Boolean).join(" · ")}</p>
      </header>

      <section className="layout-workspace" aria-label={`${entry.name} layout preview`}>
        {entry.layout.dockRoot
          ? <DockPreview node={entry.layout.dockRoot} panes={panes} />
          : <p>No docked panes</p>}
        {extra.length > 0 ? (
          <div className="layout-extra-panes">
            {extra.map((pane) => <PaneCard key={pane.instanceId} pane={pane} />)}
          </div>
        ) : null}
      </section>

      <div className="handoff">
        <a className="cta" href={openLiveUrl}>Use this layout</a>
        <p className="descriptor">Opens in Gloomberb as an independent, editable copy.</p>
      </div>
    </main>
  );
}
