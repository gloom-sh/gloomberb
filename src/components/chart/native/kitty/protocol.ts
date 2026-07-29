import { deflateSync } from "node:zlib";

export interface KittyPlacement {
  imageId: number;
  placementId: number;
  column: number;
  row: number;
  cols: number;
  rows: number;
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
  xOffset?: number;
  yOffset?: number;
  zIndex?: number;
}

export interface KittyTransmitOptions {
  imageId: number;
  width: number;
  height: number;
  rgba: Uint8Array;
  chunkSize?: number;
}

const APC_START = "\x1b_G";
const APC_END = "\x1b\\";
const DEFAULT_CHUNK_SIZE = 4096;

function buildControlData(entries: Array<[string, string | number | null | undefined]>): string {
  return entries
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function wrapKittySequence(control: string, payload = ""): string {
  return `${APC_START}${control};${payload}${APC_END}`;
}

export function chunkBase64Payload(base64: string, chunkSize = DEFAULT_CHUNK_SIZE): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < base64.length; index += chunkSize) {
    chunks.push(base64.slice(index, index + chunkSize));
  }
  return chunks.length > 0 ? chunks : [""];
}

export function buildKittyGraphicsQuery(imageId = 31): string {
  return wrapKittySequence(`i=${imageId},s=1,v=1,a=q,t=d,f=24`, "AAAA");
}

export function encodeKittyTransmitRgba(options: KittyTransmitOptions): string[] {
  // ponytail: level 3 compresses chart pixels ~2.5x faster than the default for
  // ~40% more bytes; crosshair moves retransmit the whole plot every frame, so
  // CPU is the constraint on a local pty. Raise it if bandwidth ever is.
  const compressed = deflateSync(options.rgba, { level: 3 });
  const chunks = chunkBase64Payload(compressed.toString("base64"), options.chunkSize);

  return chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    const control = index === 0
      ? buildControlData([
        ["a", "t"],
        ["f", 32],
        ["t", "d"],
        ["o", "z"],
        ["s", options.width],
        ["v", options.height],
        ["i", options.imageId],
        ["q", 2],
        ["m", isLast ? 0 : 1],
      ])
      : buildControlData([
        ["m", isLast ? 0 : 1],
      ]);

    return wrapKittySequence(control, chunk);
  });
}

export function encodeKittyPlacement(placement: KittyPlacement): string {
  const control = buildControlData([
    ["a", "p"],
    ["i", placement.imageId],
    ["p", placement.placementId],
    ["q", 2],
    ["x", placement.cropX ?? 0],
    ["y", placement.cropY ?? 0],
    ["w", placement.cropWidth ?? 0],
    ["h", placement.cropHeight ?? 0],
    ["X", placement.xOffset ?? 0],
    ["Y", placement.yOffset ?? 0],
    ["c", placement.cols],
    ["r", placement.rows],
    ["z", placement.zIndex ?? -1],
    ["C", 1],
  ]);

  return `\x1b[s\x1b[${placement.row};${placement.column}H${wrapKittySequence(control)}\x1b[u`;
}

export function encodeKittyDeleteImage(imageId: number, placementId?: number): string {
  return wrapKittySequence(buildControlData([
    ["a", "d"],
    ["d", "I"],
    ["i", imageId],
    ["p", placementId ?? null],
    ["q", 2],
  ]));
}
