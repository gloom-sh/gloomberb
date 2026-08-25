/** @jsxImportSource react */
import type { ShareRecord } from "../../shares/api";

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
    const facts = paneFacts(share.data.data);
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
  const values = share.data.series.flatMap((series) => series.points.map((point) => point.y));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return (
    <main className="wide">
      <h1>{share.data.title}</h1>
      <svg className="chart" viewBox="0 0 1000 420" role="img" aria-label={share.data.title}>
        {share.data.series.map((series, seriesIndex) => {
          const points = series.points.map((point, index) => {
            const x = series.points.length <= 1 ? 500 : 20 + (index / (series.points.length - 1)) * 960;
            const y = 400 - ((point.y - min) / span) * 380;
            return `${x},${y}`;
          }).join(" ");
          return <polyline key={series.name} points={points} className={`series series-${seriesIndex % 6}`} />;
        })}
      </svg>
      <ul className="legend">{share.data.series.map((series) => <li key={series.name}>{series.name}</li>)}</ul>
      <SourceLink url={share.data.sourceUrl} />
      {ownerActions}
    </main>
  );
}
