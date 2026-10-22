/** @jsxImportSource react */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { ImageSurfaceProps } from "../../../ui/host";
import { cleanDomProps, commonStyle } from "./style";

/**
 * Images that failed to load this session, such as a company with no logo:
 * a row scrolled back into view draws its fallback at once rather than an
 * empty box while it asks again.
 */
const failedImages = new Set<string>();
const FAILED_IMAGES_KEPT = 2_000;

function rememberFailedImage(src: string): void {
  if (failedImages.size >= FAILED_IMAGES_KEPT) failedImages.delete(failedImages.values().next().value!);
  failedImages.add(src);
}

/** An image filling its box; `children` stand in without a `src`, or once it fails to load. */
export function WebImageSurface({ children, src, alt = "", objectFit = "contain", ...props }: ImageSurfaceProps) {
  const imageSrc = typeof src === "string" ? src.trim() : "";
  const [failed, setFailed] = useState(() => failedImages.has(imageSrc));
  useEffect(() => setFailed(failedImages.has(imageSrc)), [imageSrc]);
  const baseStyle = commonStyle(props);
  return (
    <div
      {...cleanDomProps(props)}
      style={{
        ...baseStyle,
        overflow: baseStyle.overflow ?? "hidden",
        ...(props.style as CSSProperties | undefined),
      }}
    >
      {imageSrc && !failed ? (
        <img
          key={imageSrc}
          src={imageSrc}
          alt={alt}
          draggable={false}
          onError={() => {
            rememberFailedImage(imageSrc);
            setFailed(true);
          }}
          style={{ width: "100%", height: "100%", display: "block", objectFit }}
        />
      ) : children as ReactNode}
    </div>
  );
}
