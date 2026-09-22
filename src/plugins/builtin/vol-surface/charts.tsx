import { useMemo } from "react";
import { EmptyState, KeyValueRow, StaticChartSurface, type StaticChartOverlay } from "../../../components";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import { resolveChartPalette } from "../../../components/chart/core/palette";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, ScrollBox, Text } from "../../../ui";
import { evaluateSmile, optionDelta } from "../shared/volatility";
import { buildSurfaceGrid, evaluateSurfaceSmile, type SurfaceExpiry, type SurfaceSnapshot } from "./model";

export const formatIv = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "--" : `${(value * 100).toFixed(2)}%`;
export const formatPrice = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "--" : value.toFixed(2);
export const expiryLabel = (expiration: number) => new Date(expiration * 1000).toISOString().slice(0, 10);
const point = (x: number, y: number): ProjectedChartPoint => ({ date: new Date(Math.round(x * 1_000_000)), open: y, high: y, low: y, close: y, volume: 0 });

export function SmileChart({ snapshot, expiry, overlay, axis, width, height }: {
  snapshot: SurfaceSnapshot; expiry: SurfaceExpiry | null; overlay: boolean;
  axis: string; width: number; height: number;
}) {
  const colors = useThemeColors();
  const palette = resolveChartPalette(colors);
  const model = useMemo(() => {
    if (!expiry?.fit || !expiry.forward || expiry.points.length < 2) return null;
    const strikes = expiry.points.map((entry) => entry.strike).sort((a, b) => a - b);
    const min = strikes[0]!, max = strikes.at(-1)!;
    const grid = [...new Set([...strikes, ...Array.from({ length: 81 }, (_, i) => min + (max - min) * i / 80)])].sort((a, b) => a - b);
    const x = (strike: number) => {
      if (axis === "strike") return strike;
      if (axis === "delta") {
        const volatility = evaluateSmile(expiry.fit!, Math.log(strike / expiry.forward!));
        const delta = volatility == null ? null : optionDelta({ spot: snapshot.spot, years: expiry.years,
          volatility, rate: expiry.rate ?? 0, dividendYield: expiry.dividendYield ?? 0 }, strike, "call");
        return delta == null ? NaN : (1 - delta) * 100;
      }
      return strike / (axis === "forward" ? expiry.forward! : snapshot.spot) * 100;
    };
    const observations = grid.flatMap((strike) => {
      const volatility = evaluateSmile(expiry.fit!, Math.log(strike / expiry.forward!));
      const coordinate = x(strike);
      return volatility == null || !Number.isFinite(coordinate) ? [] : [{ strike, x: coordinate, iv: volatility }];
    }).sort((a, b) => a.x - b.x);
    const raw: StaticChartOverlay = { id: "Clean quotes", color: colors.warning, style: "points", points: [] };
    observations.forEach((observation, index) => {
      const quote = expiry.points.find((entry) => entry.strike === observation.strike);
      if (quote) (raw.points as {index:number;value:number}[]).push({ index, value: quote.volatility * 100 });
    });
    const overlays: StaticChartOverlay[] = [raw];
    if (overlay) {
      const peers = snapshot.expiries.filter((entry) => entry.fit && entry.forward && entry.expiration !== expiry.expiration)
        .sort((a, b) => Math.abs(a.years - expiry.years) - Math.abs(b.years - expiry.years)).slice(0, 2);
      peers.forEach((peer, peerIndex) => overlays.push({ id: expiryLabel(peer.expiration), color: peerIndex ? colors.negative : colors.textDim,
        points: observations.flatMap((observation, index) => {
          const strike = axis === "forward" ? observation.x / 100 * peer.forward!
            : axis === "delta" ? buildSurfaceGrid({ ...snapshot, expiries: [peer] }, {
              axis: "delta", coordinates: [1 - observation.x / 100],
            }).rows[0]?.cells[0]?.strike ?? NaN : observation.strike;
          const value = evaluateSurfaceSmile(peer, strike);
          return value == null ? [] : [{ index, value: value * 100 }];
        }) }));
    }
    const left = observations[0]?.x ?? 0, right = observations.at(-1)?.x ?? 1;
    return { points: observations.map((entry) => point(entry.x, entry.iv * 100)), overlays,
      ticks: Array.from({ length: 5 }, (_, i) => ({ ratio: i / 4, label: (left + (right - left) * i / 4).toFixed(axis === "strike" ? 2 : 0) })),
      left, right };
  }, [axis, colors, expiry, overlay, snapshot]);
  if (!model) return <EmptyState title="Smile unavailable." hint="No clean quoted smile for this expiry." />;
  const axisLabel = axis === "strike" ? "Strike" : axis === "delta" ? "100 x (1 - call delta)" : `${axis === "forward" ? "Forward" : "Spot"} %`;
  return <Box flexDirection="column" width={width} height={height}>
    <Box height={1} flexDirection="row" gap={3} paddingX={1}>
      <Text fg={palette.lineColor}>Fitted smile</Text>
      <Text fg={colors.warning}>Clean quotes</Text>
      {model.overlays.filter((entry) => entry.id !== "Clean quotes").map((entry) => <Text key={entry.id} fg={entry.color}>{entry.id}</Text>)}
    </Box>
    <StaticChartSurface points={model.points} overlays={model.overlays} calendarSpaced width={width} height={Math.max(3, height - 1)}
      colors={palette} yAxisLabel={`IV % · ${axisLabel}`} formatYAxisValue={(value) => `${value.toFixed(1)}%`}
      xAxisTicks={model.ticks} formatXAxisCursorValue={(ratio) => `${axisLabel} ${(model.left + ratio * (model.right - model.left)).toFixed(2)}`} />
  </Box>;
}

export function TermChart({ snapshot, width, height }: { snapshot: SurfaceSnapshot; width: number; height: number }) {
  const colors = useThemeColors();
  const rows = snapshot.expiries.filter((expiry) => expiry.atmIV != null).sort((a, b) => a.years - b.years);
  if (!rows.length) return <EmptyState title="Term structure unavailable." hint="No clean ATM observations." />;
  const first = rows[0]!.years * 365, last = rows.at(-1)!.years * 365;
  const points = rows.map((expiry) => point(expiry.years * 365, expiry.atmIV! * 100));
  const overlays: StaticChartOverlay[] = [
    { id: "25d put", color: colors.warning, points: rows.flatMap((expiry, index) => expiry.skew.put25 == null ? [] : [{ index, value: expiry.skew.put25 * 100 }]) },
    { id: "25d call", color: colors.negative, points: rows.flatMap((expiry, index) => expiry.skew.call25 == null ? [] : [{ index, value: expiry.skew.call25 * 100 }]) },
  ];
  const moveHeight = Math.min(7, Math.max(2, Math.floor(height / 4)));
  return <Box flexDirection="column" width={width} height={height}>
    <Box height={1} flexDirection="row" gap={3} paddingX={1}>
      <Text fg={colors.positive}>ATM spot</Text><Text fg={colors.warning}>25d put</Text><Text fg={colors.negative}>25d call</Text>
    </Box>
    <StaticChartSurface points={points} overlays={overlays} calendarSpaced width={width} height={Math.max(3, height - moveHeight - 1)}
      colors={resolveChartPalette(colors)} yAxisLabel="IV % · calendar days" formatYAxisValue={(value) => `${value.toFixed(1)}%`}
      xAxisTicks={Array.from({ length: 5 }, (_, i) => ({ ratio: i / 4, label: `${Math.round(first + (last - first) * i / 4)}d` }))}
      formatXAxisCursorValue={(ratio) => `${(first + ratio * (last - first)).toFixed(1)} days`} />
    <ScrollBox flexDirection="column" paddingX={1} height={moveHeight} scrollY focusable={false}>
      {rows.map((expiry) => <KeyValueRow key={expiry.expiration}
        label={expiryLabel(expiry.expiration)} labelWidth={12} width={Math.max(1, width - 2)}
        value={`${formatPrice(expiry.expectedMove.straddle)} straddle / ${formatPrice(expiry.expectedMove.sigma)} 1-sigma (${formatPrice(expiry.expectedMove.sigmaPercent)}%)`} />)}
    </ScrollBox>
  </Box>;
}
