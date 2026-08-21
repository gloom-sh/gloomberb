/** @jsxImportSource react */
import type { ShareRecord } from "../../shares/api";

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
  deleting = false,
  deleteError,
  onDelete,
}: {
  share: ShareRecord;
  deleting?: boolean;
  deleteError?: string;
  onDelete?: () => void;
}) {
  const ownerActions = (
    <OwnerActions deleting={deleting} error={deleteError} onDelete={onDelete} />
  );
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
