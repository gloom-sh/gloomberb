import { type NativeRendererHost as CliRenderer } from "../../../../ui";
import type { NativeChartBitmap, NativePlacement } from "../chart-rasterizer";
import { writeRendererRaw } from "./adapter";
import { encodeKittyDeleteImage, encodeKittyPlacement, encodeKittyTransmitRgba } from "./protocol";

let nextImageId = 2000;
let nextPlacementId = 1;

function allocateImageId(): number {
  const id = nextImageId;
  nextImageId += 1;
  return id;
}

function allocatePlacementId(): number {
  const id = nextPlacementId;
  nextPlacementId += 1;
  return id;
}

function serializePlacement(placement: NativePlacement): string {
  return [
    placement.column,
    placement.row,
    placement.cols,
    placement.rows,
    placement.cropX,
    placement.cropY,
    placement.cropWidth,
    placement.cropHeight,
    placement.zIndex ?? "",
  ].join(":");
}

function asPlacementArray(placement: NativePlacement | NativePlacement[]): NativePlacement[] {
  return Array.isArray(placement) ? placement : [placement];
}

export class KittyImageManager {
  private readonly imageIds = [allocateImageId(), allocateImageId()] as const;
  private readonly placementIds: number[] = [];
  private activeSlot: 0 | 1 | null = null;
  private lastBitmapKey: string | null = null;
  private lastPlacementKeys: string[] = [];

  constructor(private readonly renderer: CliRenderer) {}

  render(bitmap: NativeChartBitmap, placement: NativePlacement | NativePlacement[], bitmapKey: string) {
    const placements = asPlacementArray(placement);
    if (this.activeSlot !== null && this.lastBitmapKey === bitmapKey) {
      this.placeActive(placements);
      return;
    }

    const nextSlot: 0 | 1 = this.activeSlot === 0 ? 1 : 0;
    const imageId = this.imageIds[nextSlot];
    const placementIds = this.ensurePlacementIds(placements.length);
    const sequences = [
      ...encodeKittyTransmitRgba({
        imageId,
        width: bitmap.width,
        height: bitmap.height,
        rgba: bitmap.pixels,
      }),
      ...placements.map((entry, index) => encodeKittyPlacement({
        imageId,
        placementId: placementIds[index]!,
        column: entry.column,
        row: entry.row,
        cols: entry.cols,
        rows: entry.rows,
        cropX: entry.cropX,
        cropY: entry.cropY,
        cropWidth: entry.cropWidth,
        cropHeight: entry.cropHeight,
        zIndex: entry.zIndex,
      })),
    ];

    if (this.activeSlot !== null) {
      sequences.push(encodeKittyDeleteImage(this.imageIds[this.activeSlot]));
    }

    writeRendererRaw(this.renderer, sequences.join(""));
    this.activeSlot = nextSlot;
    this.lastBitmapKey = bitmapKey;
    this.lastPlacementKeys = placements.map(serializePlacement);
  }

  placeActive(placement: NativePlacement | NativePlacement[]) {
    if (this.activeSlot === null) return;
    const placements = asPlacementArray(placement);
    const imageId = this.imageIds[this.activeSlot];
    const placementIds = this.ensurePlacementIds(placements.length);
    const sequences: string[] = [];

    placements.forEach((entry, index) => {
      const placementKey = serializePlacement(entry);
      if (placementKey === this.lastPlacementKeys[index]) return;
      sequences.push(encodeKittyPlacement({
        imageId,
        placementId: placementIds[index]!,
        column: entry.column,
        row: entry.row,
        cols: entry.cols,
        rows: entry.rows,
        cropX: entry.cropX,
        cropY: entry.cropY,
        cropWidth: entry.cropWidth,
        cropHeight: entry.cropHeight,
        zIndex: entry.zIndex,
      }));
    });

    for (let index = placements.length; index < this.lastPlacementKeys.length; index += 1) {
      sequences.push(encodeKittyDeleteImage(imageId, placementIds[index]!));
    }

    if (sequences.length === 0) return;

    writeRendererRaw(this.renderer, sequences.join(""));
    this.lastPlacementKeys = placements.map(serializePlacement);
  }

  clear() {
    writeRendererRaw(
      this.renderer,
      `${encodeKittyDeleteImage(this.imageIds[0])}${encodeKittyDeleteImage(this.imageIds[1])}`,
    );
    this.forgetPlacedImages();
  }

  forgetPlacedImages() {
    this.activeSlot = null;
    this.lastBitmapKey = null;
    this.lastPlacementKeys = [];
  }

  destroy() {
    this.clear();
  }

  private ensurePlacementIds(count: number): number[] {
    while (this.placementIds.length < count) {
      this.placementIds.push(allocatePlacementId());
    }
    return this.placementIds;
  }
}
