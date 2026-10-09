import type { RefObject } from "react";
import type {
  GeoColumnFormat,
  GeoEntityPayload,
  GeoEntityRow,
  GeoLayerInfo,
  GeoPropValue,
  GeoSeriesInfo,
  GeoTickerLink,
} from "../../../api-client/geo";
import { ActionRow, DetailScrollBody, KeyValueRow, Section, StatGrid, type StatItem } from "../../../components";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, type ScrollBoxRenderable } from "../../../ui";
import { clipToDisplayWidth, displayWidth } from "../../../utils/format";
import { formatGeoValue, isChangeColumn, tickerLinkKey } from "./layers";

interface EntityDetailProps {
  layer: GeoLayerInfo;
  row: GeoEntityRow | null;
  detail: GeoEntityPayload | null;
  /** The entity's series, main one first. */
  series: readonly GeoSeriesInfo[];
  width: number;
  now: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onOpenTicker: (link: GeoTickerLink) => void;
  onOpenSeries: (series: GeoSeriesInfo) => void;
}

const SHORT_KEYS = new Set(["mmsi", "imo", "iata", "icao", "id"]);

/** A number stored as a code (`shipType`, `navStatus`) means nothing on its own, so the detail leaves it out. */
function isNumericCode(key: string, value: GeoPropValue): boolean {
  return typeof value === "number" && /(Type|Status|Code)$/.test(key);
}

/** The unit a key carries that no column format draws: metres and degrees. */
function detailText(key: string, value: GeoPropValue, now: number): string {
  if (typeof value === "number" && /Deg$/.test(key)) return `${Math.round(value)}°`;
  if (typeof value === "number" && /[a-z]M$/.test(key)) return `${formatGeoValue(value, Number.isInteger(value) ? "int" : "decimal1", now)} m`;
  return formatGeoValue(value, detailFormat(key, value), now);
}

/** Detail fields carry no column format; the server puts units in the key (`lastSeen`, `importSharePct`). */
function detailFormat(key: string, value: GeoPropValue): GeoColumnFormat | undefined {
  if (SHORT_KEYS.has(key.toLowerCase())) return "text";
  if (typeof value === "string" && /(At|Seen|Time)$/.test(key)) return "datetime";
  if (typeof value !== "number") return undefined;
  if (/Pct$/.test(key)) return "percent1";
  if (/Km$/.test(key)) return "km";
  if (/Kn$/.test(key)) return "knots";
  return Number.isInteger(value) ? "int" : "decimal1";
}

/** `lastSeen` reads "Last seen", `mmsi` reads "MMSI". */
function humanizeKey(key: string): string {
  if (SHORT_KEYS.has(key.toLowerCase())) return key.toUpperCase();
  // The unit suffix moves into the value: "importSharePct" reads "Import share", "lengthM" "Length".
  const words = key.replace(/(Pct|Km|Kn|Deg|M)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b(\d+)d\b/g, "$1D");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function trailSpan(trail: GeoEntityPayload["trail"]): string | null {
  if (!trail || trail.length < 2) return null;
  const start = Date.parse(trail[0]![2]);
  const end = Date.parse(trail.at(-1)![2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const minutes = Math.round((end - start) / 60_000);
  return minutes < 90 ? `Last ${minutes}m` : `Last ${Math.round(minutes / 60)}h`;
}

const VIA_WORDS: Record<GeoTickerLink["via"], string> = {
  owner: "Owner",
  operator: "Operator",
  route: "Route",
  sector: "Sector",
};

/** One row, one line: a label and what it is, clipped so a long note never wraps over the next row. */
function LinkRow({ label, detail, width, onPress }: { label: string; detail: string; width: number; onPress: () => void }) {
  const colors = useThemeColors();
  const room = Math.max(0, width - displayWidth(label) - 3);
  return (
    <ActionRow label={label} onPress={onPress} width={width}>
      {room > 3 ? <Text fg={colors.textDim}>{clipToDisplayWidth(detail, room)}</Text> : null}
    </ActionRow>
  );
}

/** One entity: its figures, the companies it links to, its series and the rest of its fields. */
export function EntityDetail({ layer, row, detail, series, width, now, scrollRef, onOpenTicker, onOpenSeries }: EntityDetailProps) {
  const props: Record<string, GeoPropValue> = { ...row?.props, ...detail?.feature.props, ...detail?.detail };
  const columns = layer.columns.filter((column) => column.key !== "label");
  const shown = new Set(["label", ...columns.map((column) => column.key)]);
  const figures: StatItem[] = columns.flatMap((column) => {
    const value = formatGeoValue(props[column.key], column.format, now, isChangeColumn(column));
    return value ? [{ id: column.key, label: column.label, value }] : [];
  });
  const tickers = detail?.feature.tickers ?? row?.tickers ?? [];
  const track = trailSpan(detail?.trail);
  const title = row?.label ?? detail?.feature.label;
  // The stack header already names the entity, so a `name` field that repeats it is left out.
  const rest = Object.entries(props).filter(([key, value]) => !shown.has(key) && value !== null && value !== "" && value !== title && !isNumericCode(key, value));
  const innerWidth = Math.max(10, width - 2);
  const labelWidth = Math.min(16, Math.max(8, ...rest.map(([key]) => displayWidth(humanizeKey(key)) + 1), track ? 6 : 0));
  return (
    <DetailScrollBody ref={scrollRef} resetScrollKey={`${layer.id}:${row?.id ?? detail?.feature.id ?? ""}`}>
      {figures.length ? <StatGrid items={figures} width={innerWidth} /> : null}
      {tickers.length ? (
        <Section title="Linked Tickers" width={innerWidth}>
          {tickers.map((link) => (
            <LinkRow
              key={`${tickerLinkKey(link)}:${link.via}`}
              label={link.symbol}
              detail={[VIA_WORDS[link.via] ?? link.via, link.confidence === "inferred" ? "inferred" : null, link.note ?? null].filter(Boolean).join(" · ")}
              width={innerWidth}
              onPress={() => onOpenTicker(link)}
            />
          ))}
        </Section>
      ) : null}
      {series.length ? (
        <Section title="Series" width={innerWidth}>
          {series.map((entry) => (
            <LinkRow key={entry.id} label={entry.name} detail={entry.frequency} width={innerWidth} onPress={() => onOpenSeries(entry)} />
          ))}
        </Section>
      ) : null}
      {track || rest.length ? (
        <Section title="Details" width={innerWidth}>
          <Box flexDirection="column">
            {track ? <KeyValueRow label="Track" value={track} width={innerWidth} labelWidth={labelWidth} /> : null}
            {rest.map(([key, value]) => (
              <KeyValueRow key={key} label={humanizeKey(key)} value={detailText(key, value, now)} width={innerWidth} labelWidth={labelWidth} />
            ))}
          </Box>
        </Section>
      ) : null}
    </DetailScrollBody>
  );
}
