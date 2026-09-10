/** @jsxImportSource react */
import type { ShareRecord } from "../../shares/api";
import { sharedChartGeometry, sharedChartLinePoints } from "./chart";

const FACT_LIMIT = 8;
const FACT_MAX_LENGTH = 120;

function factValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value.trim().slice(0, FACT_MAX_LENGTH) : null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    const items = value.filter((item) => typeof item === "string" || typeof item === "number");
    return items.length ? items.join(", ").slice(0, FACT_MAX_LENGTH) : null;
  }
  return null;
}

function factLabel(key: string): string {
  const spaced = key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

function paneFacts(data: Record<string, unknown>): Array<{ key: string; label: string; value: string }> {
  const facts: Array<{ key: string; label: string; value: string }> = [];
  for (const [key, raw] of Object.entries(data)) {
    const value = factValue(raw);
    if (value !== null) facts.push({ key, label: factLabel(key), value });
    if (facts.length === FACT_LIMIT) break;
  }
  return facts;
}

function SourceLink({ url }: { url?: string }) {
  return url ? <a href={url} target="_blank" rel="noopener noreferrer">View source</a> : null;
}

function OwnerActions({
  deleting,
  error,
  onDelete,
}: {
  deleting: boolean;
  error?: string;
  onDelete?: () => void;
}) {
  if (!onDelete) return null;
  return (
    <div className="owner-actions">
      <button type="button" disabled={deleting} onClick={onDelete}>
        {deleting ? "Deleting..." : "Delete share"}
      </button>
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
}

export function ShareView({
  share,
  openLiveUrl,
  deleting = false,
  deleteError,
  onDelete,
}: {
  share: ShareRecord;
  /** Platform-tracked `/shares/:id/open` URL. */
  openLiveUrl?: string;
  deleting?: boolean;
  deleteError?: string;
  onDelete?: () => void;
}) {
  const ownerActions = (
    <OwnerActions deleting={deleting} error={deleteError} onDelete={onDelete} />
  );
  if (share.kind === "pane") {
    const instance = share.data.version === 2
      ? share.data.layout.layout.instances[0]
      : null;
    const facts = share.data.version === 1
      ? paneFacts(share.data.data)
      : paneFacts({
          paneType: instance
            ? factLabel(instance.paneId).replace(/\b\w/g, (character) => character.toUpperCase())
            : undefined,
          ...(instance?.binding?.kind === "fixed" ? { symbol: instance.binding.symbol } : {}),
          ...(instance?.params ?? {}),
          ...(instance?.settings ?? {}),
        });
    return (
      <main className="pane">
        <header>
          <p className="eyebrow">Shared via Gloomberb</p>
          <h1>{share.data.title}</h1>
          {share.data.description ? <p className="pane-description">{share.data.description}</p> : null}
        </header>
        {facts.length ? (
          <dl className="pane-facts">
            {facts.map((fact) => (
              <div key={fact.key}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="handoff">
          {openLiveUrl ? <a className="cta" href={openLiveUrl}>Explore this pane live</a> : null}
          <p className="descriptor">A free, open-source finance terminal for market data, charts, and research.</p>
        </div>
        {ownerActions}
      </main>
    );
  }
  if (share.kind === "article") {
    return <main><h1>{share.data.title}</h1><p className="article-text">{share.data.text}</p><SourceLink url={share.data.sourceUrl} />{ownerActions}</main>;
  }
  if (share.kind === "table") {
    return (
      <main className="wide">
        <h1>{share.data.title}</h1>
        <div className="table-wrap"><table><thead><tr>{share.data.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
          <tbody>{share.data.rows.map((row, index) => <tr key={index}>{share.data.columns.map((column) => <td key={column.key}>{String(row[column.key] ?? "")}</td>)}</tr>)}</tbody>
        </table></div>
        <SourceLink url={share.data.sourceUrl} />
        {ownerActions}
      </main>
    );
  }
  const chart = sharedChartGeometry(share.data);
  const format = (value: number) => value.toLocaleString("en-US", { maximumSignificantDigits: 6 });
  return (
    <main className="wide">
      <h1>{share.data.title}</h1>
      <p className="snapshot-date">Snapshot shared {new Date(share.createdAt).toISOString().replace("T", " ").slice(0, 16)} UTC. Observation dates appear below.</p>
      {chart.panels.map((panel) => <section className="chart-panel" key={panel.unit} aria-label={`${panel.unit} chart`}>
        <strong className="chart-unit">{panel.unit}</strong>
        {panel.hasValues ? <><div className="chart-plot"><div className="chart-y-axis"><span>{format(panel.max)}</span><span>{format((panel.max + panel.min) / 2)}</span><span>{format(panel.min)}</span></div>
        <svg className="chart" viewBox="0 0 1000 320" preserveAspectRatio="none" role="img" aria-label={`${share.data.title} — ${panel.unit}`}>
          <line x1="20" x2="980" y1="160" y2="160" className="chart-grid" />
          {panel.series.flatMap((series) => series.segments.map((segment, segmentIndex) => segment.length === 1 || series.style === "points"
            ? segment.map((point, pointIndex) => <circle key={`${series.index}:${segmentIndex}:${pointIndex}`} cx={point.x} cy={point.y} r="1" className={`series-point series-${series.index % 6}`}><title>{`${series.name}: ${point.label}`}</title></circle>)
            : <polyline key={`${series.index}:${segmentIndex}`} points={sharedChartLinePoints(segment, series.style)} className={`series series-${series.index % 6}`}><title>{series.name}</title></polyline>))}
        </svg></div>
        <div className="chart-dates"><span>{chart.startLabel}</span><span>{chart.axisLabel}</span><span>{chart.endLabel}</span></div></> : <p className="chart-unavailable">No observations available in this window.</p>}
        <ul className="legend">{panel.series.map((series) => <li key={series.index}><span className={`series-key series-${series.index % 6}`} />{series.name}</li>)}</ul>
      </section>)}
      {share.data.warnings?.length ? <ul className="chart-notes">{share.data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
      <details className="shared-data"><summary>View snapshot data</summary>
        {share.data.series.map((series, index) => <div className="table-wrap" key={index}><table>
          <caption>{series.name} · {series.unit ?? "Unit unavailable"}</caption>
          <thead><tr><th>{chart.axisLabel}</th><th>Value</th></tr></thead>
          <tbody>{series.points.map((point, pointIndex) => <tr key={pointIndex}><td>{point.x}</td><td>{point.y === null ? "Unavailable" : String(point.y)}</td></tr>)}</tbody>
        </table></div>)}
      </details>
      <SourceLink url={share.data.sourceUrl} />
      {ownerActions}
    </main>
  );
}
