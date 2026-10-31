/** @jsxImportSource react */
import { useState, type CSSProperties, type ReactNode } from "react";
import type { ImageSurfaceProps } from "../../../ui/host";
import { cleanDomProps, commonStyle } from "./style";

type ImageStatus = "loading" | "loaded" | "failed";

/**
 * Images that failed to load this session, such as a company with no logo:
 * a row scrolled back into view draws its fallback at once rather than an
 * empty box while it asks again.
 */
const failedImages = new Set<string>();
/** Images that loaded this session: a row scrolled back into view draws its picture on its first frame, not its stand-in. */
const loadedImages = new Set<string>();
const IMAGES_KEPT = 2_000;

function remember(images: Set<string>, src: string): void {
  if (images.size >= IMAGES_KEPT) images.delete(images.values().next().value!);
  images.add(src);
}

function initialStatus(src: string): ImageStatus {
  if (failedImages.has(src)) return "failed";
  return loadedImages.has(src) ? "loaded" : "loading";
}

/**
 * An image still being fetched, kept out of the layout and the paint so the
 * box shows its `children` until the picture can replace them whole.
 */
const PENDING_IMAGE_STYLE: CSSProperties = { position: "absolute", width: 0, height: 0, opacity: 0, pointerEvents: "none" };

/** An image filling its box; `children` stand in without a `src`, or once it fails to load (and while it loads with `fallbackWhileLoading`). */
export function WebImageSurface({ children, src, alt = "", objectFit = "contain", fallbackWhileLoading = false, imageBackground, ...props }: ImageSurfaceProps) {
  const imageSrc = typeof src === "string" ? src.trim() : "";
  // Keyed by the address it describes, so a row that takes another logo starts that one's own load.
  const [known, setKnown] = useState<{ src: string; status: ImageStatus }>(() => ({ src: imageSrc, status: initialStatus(imageSrc) }));
  const status = known.src === imageSrc ? known.status : initialStatus(imageSrc);
  const baseStyle = commonStyle(props);
  const waiting = fallbackWhileLoading && status === "loading";
  return (
    <div
      {...cleanDomProps(props)}
      style={{
        ...baseStyle,
        overflow: baseStyle.overflow ?? "hidden",
        ...(imageBackground && status === "loaded" ? { background: imageBackground } : {}),
        ...(props.style as CSSProperties | undefined),
      }}
    >
      {imageSrc && status !== "failed" ? (
        <>
          <img
            key={imageSrc}
            src={imageSrc}
            alt={alt}
            draggable={false}
            onLoad={() => {
              remember(loadedImages, imageSrc);
              setKnown({ src: imageSrc, status: "loaded" });
            }}
            onError={() => {
              remember(failedImages, imageSrc);
              setKnown({ src: imageSrc, status: "failed" });
            }}
            style={waiting ? PENDING_IMAGE_STYLE : { width: "100%", height: "100%", display: "block", objectFit }}
          />
          {waiting ? children as ReactNode : null}
        </>
      ) : children as ReactNode}
    </div>
  );
}
