/** @jsxImportSource react */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ImageSurfaceProps } from "../../../ui/host";
import { cleanDomProps, commonStyle } from "./style";

type ImageStatus = "loading" | "loaded" | "failed";

/**
 * Images that failed to load this session, such as a company with no logo:
 * a row scrolled back into view draws its fallback at once rather than an
 * empty box while it asks again.
 */
const failedImages = new Set<string>();
const IMAGES_KEPT = 2_000;

function remember(images: Set<string>, src: string): void {
  if (images.size >= IMAGES_KEPT) images.delete(images.values().next().value!);
  images.add(src);
}

/**
 * Every new image element starts loading, even for a picture that loaded
 * before: what counts is whether this element has it to draw. One the
 * browser still holds is complete at once, so a row scrolled back into view
 * draws it on its first frame (see the layout effect); one it has to fetch
 * again keeps the stand-in until it arrives. A loaded status carried over
 * from another element drew the white plate behind an image not yet there,
 * a blank white square in the desktop app for as long as the fetch took.
 */
function initialStatus(src: string): ImageStatus {
  return failedImages.has(src) ? "failed" : "loading";
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
  const imageRef = useRef<HTMLImageElement | null>(null);
  // Before the frame is painted: a picture the browser already holds is drawn at once, not after its stand-in.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (status === "loading" && image?.complete && image.naturalWidth > 0) setKnown({ src: imageSrc, status: "loaded" });
  }, [imageSrc, status]);
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
            ref={imageRef}
            src={imageSrc}
            alt={alt}
            draggable={false}
            onLoad={() => setKnown({ src: imageSrc, status: "loaded" })}
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
