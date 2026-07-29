import { Jimp } from "jimp";
import type { NativeChartBitmap } from "../../../components/chart/native/chart-rasterizer";

type ImageObjectFit = "contain" | "cover";

export interface JimpImageLike {
  bitmap: {
    width: number;
    height: number;
    data: ArrayLike<number>;
  };
  clone(): JimpImageLike;
  contain(options: { w: number; h: number }): JimpImageLike;
  cover(options: { w: number; h: number }): JimpImageLike;
}

function adaptJimpImage(image: JimpImageLike): JimpImageLike {
  return {
    bitmap: image.bitmap,
    clone: () => adaptJimpImage(image.clone()),
    contain: (options) => adaptJimpImage(image.contain(options)),
    cover: (options) => adaptJimpImage(image.cover(options)),
  };
}

interface ImageBitmapOptions {
  width: number;
  height: number;
  objectFit: ImageObjectFit;
}

const MAX_REMOTE_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_CACHE_LIMIT = 48;

const sourceImageCache = new Map<string, Promise<JimpImageLike>>();
const bitmapCache = new Map<string, Promise<NativeChartBitmap>>();

function remember<K, V>(cache: Map<K, V>, key: K, value: V) {
  cache.set(key, value);
  while (cache.size > IMAGE_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value as K | undefined;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

async function fetchImageBytes(src: string): Promise<Buffer> {
  const response = await fetch(src, {
    headers: {
      "User-Agent": "Gloomberb/0.6 image renderer",
    },
  });
  if (!response.ok) {
    throw new Error(`Image request failed with HTTP ${response.status}`);
  }

  const data = await response.arrayBuffer();
  if (data.byteLength > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error("Image is too large to render inline");
  }

  return Buffer.from(data);
}

function loadSourceImage(src: string): Promise<JimpImageLike> {
  const cached = sourceImageCache.get(src);
  if (cached) return cached;

  const promise = fetchImageBytes(src)
    .then((bytes) => Jimp.read(bytes))
    .then(adaptJimpImage)
    .catch((error) => {
      sourceImageCache.delete(src);
      throw error;
    });

  remember(sourceImageCache, src, promise);
  return promise;
}

export function resizeImageToBitmap(source: JimpImageLike, options: ImageBitmapOptions): NativeChartBitmap {
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));
  const image = source.clone();

  if (options.objectFit === "cover") {
    image.cover({ w: width, h: height });
  } else {
    image.contain({ w: width, h: height });
  }

  return {
    width: image.bitmap.width,
    height: image.bitmap.height,
    pixels: new Uint8Array(image.bitmap.data),
  };
}

export function loadOpenTuiImageBitmap(src: string, options: ImageBitmapOptions): Promise<NativeChartBitmap> {
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));
  const key = `${src}\n${options.objectFit}\n${width}x${height}`;
  const cached = bitmapCache.get(key);
  if (cached) return cached;

  const promise = loadSourceImage(src)
    .then((image) => resizeImageToBitmap(image, { width, height, objectFit: options.objectFit }))
    .catch((error) => {
      bitmapCache.delete(key);
      throw error;
    });

  remember(bitmapCache, key, promise);
  return promise;
}
