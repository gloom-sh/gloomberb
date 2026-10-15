/** @jsxImportSource react */
/**
 * The kit page (`?scenario=kit`, served by kit-page.ts): every family of the
 * design system in every state, drawn by the shared components themselves,
 * one screen per family (`&family=<id>`, or all of them in a column). It is
 * the benchmark docs/pane-conventions.md ("Design system") describes: a UI
 * change is compared against it. Nothing here is a component of its own; a
 * specimen that needs a look the kit does not have is a gap in the kit.
 *
 * Hover and keyboard focus are pseudo-classes: kit-page.ts forces them on the
 * elements marked `data-kit-force="hover"` or `"focus"` before it takes a
 * picture, so the page shows them still.
 */
import { Component, useState, type ReactNode } from "react";
import { Badge, Divider, KeyValueRow, SectionHeading } from "../../src/components/ui/display";
import { Button } from "../../src/components/ui/button";
import { IconButton } from "../../src/components/ui/icon";
import { Card } from "../../src/components/ui/card";
import { Checkbox } from "../../src/components/ui/checkbox";
import { DialogFrame } from "../../src/components/ui/frame";
import { EmptyState, Notice, PaneStatusBody } from "../../src/components/ui/status";
import { ExternalLinkText } from "../../src/components/ui/external-link";
import { Tabs } from "../../src/components/ui/tabs";
import { SegmentedControl } from "../../src/components/ui/toggle";
import { TextField } from "../../src/components/ui/fields";
import { SelectButton } from "../../src/components/ui/select-button";
import { QueryBar } from "../../src/components/ui/query-bar";
import { StatGrid } from "../../src/components/ui/stat-grid";
import { Menu } from "../../src/components/ui/menu";
import { DataTableView } from "../../src/components/data-table/view";
import { ArticleReader } from "../../src/components/reader/article-reader";
import { parseArticle } from "../../src/components/reader/article-text";
import { DetailReader } from "../../src/components/reader/detail-reader";
import type { DocsBlock } from "../../src/docs/content";
import { DocsBlocks, DocsReadingColumn } from "../../src/plugins/builtin/docs/blocks";
import { PaneHeader } from "../../src/components/layout/pane/header";
import { PaneFooterBar } from "../../src/components/layout/pane/footer";
import { PageStackView } from "../../src/components/ui/page-stack-view";
import { UpgradeLabel } from "../../src/plugins/builtin/shared/locked-rows";
import { useThemeColors } from "../../src/theme/theme-context";
import { TYPE } from "../../src/theme/ui-tokens";
import { Box, Text } from "../../src/ui";

export const KIT_FAMILIES = [
  ["type", "Type and colour"],
  ["tokens", "Spacing, radii and surfaces"],
  ["buttons", "Buttons"],
  ["tabs", "Tabs and segmented choices"],
  ["chips", "Chips and key caps"],
  ["fields", "Fields, selects, checkboxes and the query bar"],
  ["tables", "Tables and key-value rows"],
  ["states", "Empty, loading, notice and locked states"],
  ["content", "Headings, links, cards and dividers"],
  ["chrome", "Pane chrome"],
  ["surfaces", "Dialogs, menus and toasts"],
  ["reader", "Readers"],
] as const;

export type KitFamily = typeof KIT_FAMILIES[number][0];

const noop = () => {};
const PARAGRAPH = "Revenue rose 8% to $5.1 billion as the company sold more of its storage line, and margins widened for a third quarter. The board kept the dividend and raised the buyback by a fifth.";

/** A specimen that throws shows its error in place rather than blanking the page. */
class Specimen extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: String(error) }; }
  override render() {
    return this.state.error ? <Text fg="var(--gloom-error)">{this.state.error}</Text> : this.props.children;
  }
}

/** Cells across the page inside its margins, for the specimens that are laid out in cells. */
function pageColumns(): number {
  return Math.floor((window.innerWidth - 48) / 8);
}

/** One labelled specimen: the state's name over it, dim. */
function Sample({ label, children, force, width }: { label: string; children: ReactNode; force?: "hover" | "focus"; width?: number | string }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="column" style={{ gap: "var(--gloom-space-xs)", minWidth: 0, width }} data-kit-sample={label}>
      <Text fg={colors.textMuted}>{label}</Text>
      <Box flexDirection="row" alignItems="center" style={{ minHeight: "var(--chrome-h)" }} data-kit-force={force}>
        <Specimen>{children}</Specimen>
      </Box>
    </Box>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <Box flexDirection="row" style={{ flexWrap: "wrap", gap: "var(--gloom-space-lg) var(--gloom-space-xl)", alignItems: "flex-start" }}>{children}</Box>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box flexDirection="column" style={{ gap: "var(--gloom-space-sm)" }}>
      <SectionHeading title={title} />
      {children}
    </Box>
  );
}

function TypeFamily() {
  const colors = useThemeColors();
  const levels: Array<[string, number, number]> = [["caption", TYPE.caption, 400], ["ui", TYPE.ui, 400], ["ui bold", TYPE.ui, 700], ["body", TYPE.body, 400], ["heading", TYPE.heading, 700], ["title", TYPE.title, 700]];
  const roles: Array<[string, string]> = [
    ["text", colors.text], ["text-dim", colors.textDim], ["text-muted", colors.textMuted], ["text-bright", colors.textBright],
    ["positive", colors.positive], ["negative / error", colors.negative], ["neutral", colors.neutral], ["warning", colors.warning],
    ["accent", "var(--gloom-accent)"], ["link", "var(--gloom-link)"], ["locked", "var(--gloom-locked)"],
  ];
  return (
    <>
      <Group title="Type scale">
        {levels.map(([name, size, weight]) => (
          <Box key={name} flexDirection="row" alignItems="baseline" style={{ gap: "var(--gloom-space-lg)" }}>
            <Box style={{ width: 120, flexShrink: 0 }}><Text fg={colors.textMuted}>{`${name} ${size}px/${weight}`}</Text></Box>
            <Text fg={colors.text} style={{ fontSize: `calc(${size}px * var(--gloom-font-scale))`, fontWeight: weight, lineHeight: 1.4 }}>Quarterly revenue 5.1B, up 8%</Text>
          </Box>
        ))}
      </Group>
      <Group title="Colour roles">
        <Row>
          {roles.map(([name, colour]) => (
            <Sample key={name} label={name}><Text fg={colour}>Aa 1,234.56</Text></Sample>
          ))}
        </Row>
      </Group>
    </>
  );
}

function TokenFamily() {
  const colors = useThemeColors();
  const swatch = (style: Record<string, string | number>) => <Box style={{ width: 72, height: 36, boxSizing: "border-box", ...style }} />;
  return (
    <>
      <Group title="Spacing">
        <Row>
          {(["xs", "sm", "md", "lg", "xl"] as const).map((step) => (
            <Sample key={step} label={`space-${step}`}><Box style={{ width: `var(--gloom-space-${step})`, height: 18, background: "var(--gloom-accent)" }} /></Sample>
          ))}
          <Sample label="inset (one cell)"><Box style={{ width: "var(--gloom-inset)", height: 18, background: colors.positive }} /></Sample>
        </Row>
      </Group>
      <Group title="Radii">
        <Row>
          {([["0 bars, tables", "0"], ["sm 3 marks", "var(--gloom-radius-sm)"], ["md 6 controls", "var(--gloom-radius-md)"], ["lg 8 surfaces", "var(--gloom-radius-lg)"], ["full dots", "var(--gloom-radius-full)"]] as const).map(([label, radius]) => (
            <Sample key={label} label={label}>{swatch({ borderRadius: radius, border: "1px solid var(--gloom-control-border)", background: "var(--gloom-surface-raised)" })}</Sample>
          ))}
        </Row>
      </Group>
      <Group title="Surfaces and lines">
        <Row>
          <Sample label="surface-raised">{swatch({ background: "var(--gloom-surface-raised)", border: "1px solid var(--gloom-control-border)" })}</Sample>
          <Sample label="surface-sunken">{swatch({ background: "var(--gloom-surface-sunken)", border: "1px solid var(--gloom-control-border)" })}</Sample>
          <Sample label="band">{swatch({ background: "var(--gloom-band)" })}</Sample>
          <Sample label="hover-fill">{swatch({ background: "var(--gloom-hover-fill)" })}</Sample>
          <Sample label="selection">{swatch({ background: colors.selected })}</Sample>
          <Sample label="hairline">{swatch({ borderTop: "1px solid var(--gloom-hairline)" })}</Sample>
          <Sample label="control border">{swatch({ border: "1px solid var(--gloom-control-border)", borderRadius: "var(--gloom-radius-md)" })}</Sample>
          <Sample label="elevation">{swatch({ background: "var(--gloom-surface-raised)", borderRadius: "var(--gloom-radius-lg)", boxShadow: "var(--gloom-elevation)", border: "1px solid var(--gloom-control-border)" })}</Sample>
        </Row>
      </Group>
    </>
  );
}

function ButtonFamily() {
  const kinds = [["primary", "Upgrade"], ["secondary", "Export"], ["ghost", "Cancel"], ["danger", "Delete"]] as const;
  return (
    <>
      {kinds.map(([variant, label]) => (
        <Group key={variant} title={variant}>
          <Row>
            <Sample label="normal"><Button variant={variant} label={label} onPress={noop} /></Sample>
            <Sample label="hover" force="hover"><Button variant={variant} label={label} onPress={noop} /></Sample>
            <Sample label="focus" force="focus"><Button variant={variant} label={label} onPress={noop} /></Sample>
            <Sample label="with key"><Button variant={variant} label={label} shortcut="Enter" onPress={noop} /></Sample>
            <Sample label="compact"><Button variant={variant} label={label} compact onPress={noop} /></Sample>
            <Sample label="disabled"><Button variant={variant} label={label} disabled onPress={noop} /></Sample>
          </Row>
        </Group>
      ))}
      <Group title="Chosen">
        <Row><Sample label="active"><Button variant="secondary" active label="Log scale" onPress={noop} /></Sample></Row>
      </Group>
      <Group title="icon">
        <Row>
          <Sample label="normal"><IconButton icon="more" label="More" onPress={noop} /></Sample>
          <Sample label="hover" force="hover"><IconButton icon="more" label="More" onPress={noop} /></Sample>
          <Sample label="focus" force="focus"><IconButton icon="more" label="More" onPress={noop} /></Sample>
          <Sample label="pressed"><IconButton icon="zap" label="Live" pressed onPress={noop} /></Sample>
          <Sample label="disabled"><IconButton icon="more" label="More" disabled onPress={noop} /></Sample>
        </Row>
      </Group>
    </>
  );
}

function TabsFamily() {
  const tabs = [{ label: "Overview", value: "overview" }, { label: "Financials", value: "financials" }, { label: "Holders", value: "holders" }, { label: "Locked", value: "locked", disabled: true }];
  const [value, setValue] = useState("overview");
  const [choice, setChoice] = useState("1y");
  return (
    <>
      <Group title="Tabs">
        <Row>
          <Sample label="active, inactive, disabled" width={420}><Box style={{ height: "var(--chrome-h)", width: "100%" }}><Tabs tabs={tabs} activeValue={value} onSelect={setValue} focused /></Box></Sample>
        </Row>
        <Row>
          <Sample label="hover on Financials" force="hover" width={420}><Box style={{ height: "var(--chrome-h)", width: "100%" }} data-kit-hover-target="Financials"><Tabs tabs={tabs} activeValue="overview" onSelect={noop} /></Box></Sample>
          <Sample label="title-bar variant" width={420}><Box style={{ height: "var(--chrome-h)", width: "100%", "--pane-tab-active-fg": "var(--gloom-text-bright)" }}><Tabs tabs={tabs} activeValue="financials" onSelect={noop} variant="header" /></Box></Sample>
        </Row>
      </Group>
      <Group title="Segmented choice">
        <Row>
          <Sample label="segmented control"><SegmentedControl options={[{ label: "1M", value: "1m" }, { label: "1Y", value: "1y" }, { label: "5Y", value: "5y" }]} value={choice} onChange={setChoice} /></Sample>
        </Row>
      </Group>
    </>
  );
}

function ChipsFamily() {
  return (
    <>
      <Group title="Chips">
        <Row>
          {(["neutral", "accent", "positive", "negative", "warning"] as const).map((tone) => (
            <Sample key={tone} label={tone}><Badge label={tone === "neutral" ? "ETF" : tone.toUpperCase()} tone={tone} /></Sample>
          ))}
          <Sample label="solid"><Badge label="NEW" tone="accent" variant="solid" /></Sample>
        </Row>
      </Group>
      <Group title="Key caps">
        <Row>
          <Sample label="on a primary button"><Button variant="primary" label="Save" shortcut="Enter" onPress={noop} /></Sample>
          <Sample label="on a ghost button"><Button variant="ghost" label="Close" shortcut="Esc" onPress={noop} /></Sample>
          <Sample label="in the query bar search"><Box style={{ width: 280 }}><QueryBar width={34} search={{ value: "", onChange: noop, placeholder: "ticker or name", focused: true, active: false, onActiveChange: noop }} /></Box></Sample>
        </Row>
      </Group>
    </>
  );
}

function FieldsFamily() {
  const [checked, setChecked] = useState(true);
  return (
    <>
      <Group title="Text field">
        <Row>
          <Sample label="empty" width={220}><TextField label="" value="" placeholder="Ticker or name" focused={false} width={26} onChange={noop} /></Sample>
          <Sample label="filled" width={220}><TextField label="" value="AAPL" placeholder="Ticker" focused={false} width={26} onChange={noop} /></Sample>
          <Sample label="focused" width={220}><TextField label="" value="AAP" placeholder="Ticker" focused width={26} onChange={noop} /></Sample>
          <Sample label="with label and hint" width={220}><TextField label="Strike" value="250" focused={false} width={26} hint="Between 100 and 400" onChange={noop} /></Sample>
        </Row>
      </Group>
      <Group title="Select">
        <Row>
          <Sample label="inline, in a toolbar"><SelectButton label="Currency" value="usd" options={[{ value: "usd", label: "USD" }, { value: "eur", label: "EUR" }]} onChange={noop} width={12} /></Sample>
          <Sample label="field, in a form"><SelectButton label="Currency" variant="field" value="usd" options={[{ value: "usd", label: "USD" }, { value: "eur", label: "EUR" }]} onChange={noop} width={16} /></Sample>
          <Sample label="disabled"><SelectButton label="Currency" variant="field" disabled value="usd" options={[{ value: "usd", label: "USD" }]} onChange={noop} width={16} /></Sample>
        </Row>
      </Group>
      <Group title="Checkbox">
        <Row>
          <Sample label="checked"><Checkbox label="Attach screenshot" checked={checked} onChange={setChecked} /></Sample>
          <Sample label="unchecked"><Checkbox label="Attach screenshot" checked={false} onChange={noop} /></Sample>
          <Sample label="focus" force="focus"><Checkbox label="Attach screenshot" checked={false} onChange={noop} /></Sample>
          <Sample label="disabled"><Checkbox label="Attach screenshot" checked={false} disabled onChange={noop} /></Sample>
        </Row>
      </Group>
      <Group title="Query bar">
        <Box style={{ width: "100%" }}>
          <QueryBar
            width={Math.min(120, pageColumns())}
            search={{ value: "", onChange: noop, placeholder: "company or ticker", focused: true, active: false, onActiveChange: noop }}
            filters={[
              { id: "country", label: "Country", value: "all", options: [{ value: "all", label: "All countries" }, { value: "us", label: "United States" }], onChange: noop },
              { id: "sector", label: "Sector", value: "tech", defaultValue: "all", options: [{ value: "all", label: "All" }, { value: "tech", label: "Technology" }], onChange: noop },
              { id: "live", kind: "toggle", label: "Live only", value: true, onChange: noop },
            ]}
            view={{ value: "1y", options: [{ value: "1m", label: "1M" }, { value: "1y", label: "1Y" }, { value: "5y", label: "5Y" }], onChange: noop }}
          />
        </Box>
      </Group>
    </>
  );
}

interface Holding { id: string; name: string; weight: string; change: string; up: boolean }
const HOLDINGS: Holding[] = [
  { id: "a", name: "Apple Inc.", weight: "7.12%", change: "+1.20%", up: true },
  { id: "b", name: "Microsoft Corp.", weight: "6.85%", change: "-0.42%", up: false },
  { id: "c", name: "NVIDIA Corp.", weight: "6.40%", change: "+3.08%", up: true },
  { id: "d", name: "Amazon.com Inc.", weight: "3.71%", change: "+0.15%", up: true },
];

function TablesFamily() {
  const colors = useThemeColors();
  const columns = [
    { id: "name", label: "Name", width: 24, align: "left" as const, flexGrow: 1 },
    { id: "weight", label: "Weight", width: 10, align: "right" as const },
    { id: "change", label: "1D", width: 10, align: "right" as const },
  ];
  return (
    <>
      <Group title="Table">
        <Box style={{ width: "100%" }} data-kit-hover-row="2">
          <DataTableView<Holding, typeof columns[number]>
            columns={columns}
            items={HOLDINGS}
            selection={{ kind: "index", selectedIndex: 0, onChange: noop }}
            focused
            rootWidth={Math.min(80, pageColumns())}
            rootHeight={6}
            fitRows
            virtualize={false}
            sortColumnId="weight"
            sortDirection="desc"
            onSortChange={noop}
            getItemKey={(row) => row.id}
            emptyStateTitle="Nothing to show"
            renderCell={(row, column) => column.id === "name"
              ? { text: row.name, color: colors.text }
              : column.id === "weight" ? { text: row.weight, color: colors.text }
              : { text: row.change, color: row.up ? colors.positive : colors.negative }}
          />
        </Box>
      </Group>
      <Group title="Key-value rows">
        <Box flexDirection="column" style={{ width: 360 }}>
          <KeyValueRow label="Market cap" value="4.91T USD" width={44} />
          <KeyValueRow label="P/E (TTM)" value="39.4" width={44} />
          <KeyValueRow label="Change" value="+2.71%" tone="positive" width={44} />
        </Box>
      </Group>
      <Group title="Figure band">
        <Box style={{ width: "100%" }}>
          <StatGrid width={Math.min(110, pageColumns())} items={[{ label: "Last", value: "343.56" }, { label: "Change", value: "+0.67%", tone: "positive" }, { label: "Volume", value: "52.1M" }, { label: "52w range", value: "164 - 352" }, { label: "Beta", value: "1.07" }, { label: "Yield", value: "0.31%" }]} />
        </Box>
      </Group>
    </>
  );
}

function StatesFamily() {
  return (
    <Row>
      <Sample label="empty" width={300}><EmptyState title="No alerts yet." message="Add one with a." /></Sample>
      <Sample label="error" width={300}><EmptyState status="error" title="Prices unavailable." message="The feed answered 503." /></Sample>
      <Sample label="loading" width={300}><PaneStatusBody loading subject="prices" /></Sample>
      <Sample label="empty in a pane body" width={300}><PaneStatusBody empty emptyTitle="Nothing to show yet." /></Sample>
      <Sample label="sign-in wall" width={300}><PaneStatusBody empty emptyTitle="Sign in to manage alerts." actions={<><Button variant="primary" label="Log in" onPress={noop} /><Button variant="secondary" label="Sign up free" onPress={noop} /></>} /></Sample>
      <Sample label="locked row" width={300}><UpgradeLabel text="Upgrade for the full history" onPress={noop} /></Sample>
      <Sample label="notice: warning" width={300}><Notice>Quotes are 15 minutes delayed.</Notice></Sample>
      <Sample label="notice: error" width={300}><Notice tone="negative">The last refresh failed; showing 10:02.</Notice></Sample>
      <Sample label="notice: muted" width={300}><Notice tone="muted">Figures are in millions.</Notice></Sample>
    </Row>
  );
}

function ContentFamily() {
  return (
    <>
      <Group title="Section heading">
        <Box style={{ width: 360 }}><SectionHeading title="Fundamentals" /></Box>
      </Group>
      <Group title="Links">
        <Row>
          <Sample label="standalone"><ExternalLinkText url="https://example.invalid/filing" label="Annual report" onOpen={noop} /></Sample>
          <Sample label="hover" force="hover"><ExternalLinkText url="https://example.invalid/filing" label="Annual report" onOpen={noop} /></Sample>
          <Sample label="in a sentence" width={360}><Text>{"See the "}<ExternalLinkText url="https://example.invalid/10k" label="10-K" inline onOpen={noop} />{" for the segment split."}</Text></Sample>
        </Row>
      </Group>
      <Group title="Cards">
        <Row>
          <Sample label="card" width={220}><Card><Text>AAPL</Text><Text>343.56 +0.67%</Text></Card></Sample>
          <Sample label="interactive, hover" force="hover" width={220}><Card onPress={noop}><Text>MSFT</Text><Text>512.40 -0.42%</Text></Card></Sample>
          <Sample label="chosen" width={220}><Card selected><Text>NVDA</Text><Text>187.10 +3.08%</Text></Card></Sample>
        </Row>
      </Group>
      <Group title="Divider">
        <Box style={{ width: 360 }}><Divider /></Box>
      </Group>
    </>
  );
}

function ChromeFamily() {
  const tabs = { tabs: [{ label: "Overview", value: "o" }, { label: "Financials", value: "f" }, { label: "Holders", value: "h" }], activeValue: "o", onSelect: noop, focused: true };
  const footer = {
    info: [{ id: "status", parts: [{ text: "15m delayed", tone: "warning" as const }] }],
    hints: [{ id: "a", key: "a", label: "dd" }, { id: "o", key: "o", label: "pen" }],
    menu: [],
    keys: [],
  };
  return (
    <>
      <Group title="Title bar">
        <Box flexDirection="column" style={{ width: "100%", gap: "var(--gloom-space-sm)" }}>
          <PaneHeader title="AAPL" width={Math.min(100, pageColumns())} focused showActions tabs={tabs} />
          <PaneHeader title="World Indices" width={Math.min(100, pageColumns())} focused={false} />
        </Box>
      </Group>
      <Group title="Footer">
        <Box flexDirection="column" style={{ width: "100%", gap: "var(--gloom-space-sm)" }}>
          <PaneFooterBar footer={footer} focused width={Math.min(100, pageColumns())} />
          <PaneFooterBar footer={footer} focused={false} width={Math.min(100, pageColumns())} />
        </Box>
      </Group>
      <Group title="Detail back row">
        <Box flexDirection="column" style={{ width: "100%", height: 60 }}>
          <PageStackView focused detailOpen onBack={noop} rootContent={null} detailContent={<Text>Detail body</Text>} detailTitle="v0.17.3 Calmer reading text" />
        </Box>
      </Group>
    </>
  );
}

function SurfacesFamily() {
  return (
    <Row>
      <Sample label="dialog" width={420}>
        <div className="gloom-dialog" style={{ width: 400 }}>
          <DialogFrame title="Send feedback" subtitle="It goes to the team, with your app version." onClose={noop}>
            <Box flexDirection="column" style={{ gap: "var(--gloom-space-md)" }}>
              <TextField label="" value="" placeholder="What happened?" focused width={44} onChange={noop} />
              <Box flexDirection="row" style={{ gap: "var(--gloom-space-sm)" }}>
                <Button variant="primary" label="Send" shortcut="Enter" onPress={noop} />
                <Button variant="secondary" label="Cancel" onPress={noop} />
              </Box>
            </Box>
          </DialogFrame>
        </div>
      </Sample>
      <Sample label="menu" width={220}>
        <div className="gloom-popover" data-density="menu" style={{ position: "static", width: 200 }}>
          <Menu label="Pane" items={[{ id: "a", label: "Settings", hint: "," }, { id: "b", label: "Share", selected: true }, { id: "c", label: "Lock", disabled: true }]} onSelect={noop} />
        </div>
      </Sample>
      <Sample label="toast" width={380}>
        <div className="gloom-toast" style={{ width: 360 }}>
          <div className="gloom-toast-indicator" />
          <div className="gloom-toast-heading"><span className="gloom-toast-title">Layout saved</span><span className="gloom-toast-subtitle">just now</span></div>
          <div className="gloom-toast-body">Research is back as you left it.</div>
        </div>
      </Sample>
    </Row>
  );
}

function ReaderFamily() {
  // The same text in each reader: two paragraphs, a section heading, a paragraph and a list (reader-checks.ts holds them to one layout).
  const short = "Margins widened for a third quarter.";
  const body = parseArticle([{ text: `${PARAGRAPH}\n\n${PARAGRAPH}` }, { heading: "Guidance", text: `${PARAGRAPH}\n\n- ${PARAGRAPH}\n- ${short}` }]);
  const docs: DocsBlock[] = [
    { type: "paragraph", text: PARAGRAPH },
    { type: "paragraph", text: PARAGRAPH },
    { type: "heading", level: 2, text: "Guidance" },
    { type: "paragraph", text: PARAGRAPH },
    { type: "list", items: [PARAGRAPH, short] },
  ];
  const column = { flex: "1 1 0", minWidth: 0, height: 1100, border: "1px solid var(--gloom-hairline)" };
  return (
    <Box flexDirection="row" style={{ gap: "var(--gloom-space-lg)", width: "100%", alignItems: "flex-start" }}>
      <Box flexDirection="column" style={column} data-kit-reader="article">
        <ArticleReader articleKey="kit" title="Storage maker beats on revenue and widens margins" meta={["Wire", "Oct 14, 2026 at 9:31 AM"]} lead={PARAGRAPH} facts={["Revenue rose 8% to $5.1 billion.", "Margin rose to 46%."]} body={body} focused={false} width={60} height={60} />
      </Box>
      <Box flexDirection="column" style={column} data-kit-reader="detail">
        <DetailReader width={60} facts={[{ label: "Status", value: "Recruiting" }, { label: "Phase", value: "2" }]} body={`${PARAGRAPH}\n\n${PARAGRAPH}\n\n## Guidance\n\n${PARAGRAPH}\n\n- **Calmer reading.** ${PARAGRAPH}\n- ${short}`} bodyFormat="markdown" />
      </Box>
      <Box flexDirection="column" style={{ ...column, padding: "var(--gloom-space-md) var(--gloom-inset)" }} data-kit-reader="docs">
        <DocsReadingColumn>
          <DocsBlocks blocks={docs} width={60} onOpenLink={noop} />
        </DocsReadingColumn>
      </Box>
    </Box>
  );
}

const FAMILY_VIEWS: Record<KitFamily, () => ReactNode> = {
  type: TypeFamily,
  tokens: TokenFamily,
  buttons: ButtonFamily,
  tabs: TabsFamily,
  chips: ChipsFamily,
  fields: FieldsFamily,
  tables: TablesFamily,
  states: StatesFamily,
  content: ContentFamily,
  chrome: ChromeFamily,
  surfaces: SurfacesFamily,
  reader: ReaderFamily,
};

/** The page: one family, or every family in a column. */
export function KitPage({ family }: { family: string | null }) {
  const colors = useThemeColors();
  const shown = KIT_FAMILIES.filter(([id]) => !family || id === family);
  return (
    <div
      data-kit-page=""
      style={{ position: "absolute", inset: 0, overflow: "auto", background: colors.bg, color: colors.text, padding: "var(--gloom-space-xl)", boxSizing: "border-box" }}
    >
      <Box flexDirection="column" style={{ gap: "var(--gloom-space-xl)" }}>
        {shown.map(([id, title]) => {
          const View = FAMILY_VIEWS[id];
          return (
            <Box key={id} flexDirection="column" style={{ gap: "var(--gloom-space-lg)" }} data-kit-family={id}>
              <Text fg={colors.textBright} style={{ fontSize: "var(--gloom-type-heading)", fontWeight: 700 }}>{title}</Text>
              <View />
            </Box>
          );
        })}
      </Box>
    </div>
  );
}
