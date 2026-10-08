import { useUiCapabilities } from "../../ui";
import { FLAG_ART, FLAG_HEIGHT, FLAG_WIDTH } from "./country-flag-art";

export interface CountryFlagProps {
  /** ISO 3166 region, or `EU` for the euro area. Anything not drawn renders nothing. */
  region: string;
}

/**
 * A small flag, 2.25 grid cells wide, for the desktop and the web. Decoration
 * only: it is hidden from assistive technology, so the label beside it stays
 * the name. The terminal draws nothing.
 */
export function CountryFlag({ region }: CountryFlagProps) {
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const art = FLAG_ART[region];
  if (!desktop || !art) return null;
  return (
    <svg
      viewBox={`0 0 ${FLAG_WIDTH} ${FLAG_HEIGHT}`}
      aria-hidden="true"
      focusable="false"
      data-gloom-role="country-flag"
      data-region={region}
      style={{
        display: "block",
        flex: "none",
        width: "calc(var(--cell-w, 8px) * 2.25)",
        height: "calc(var(--cell-w, 8px) * 1.5)",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      {art}
      <rect
        x=".5" y=".5" width={FLAG_WIDTH - 1} height={FLAG_HEIGHT - 1} rx="3"
        fill="none" stroke="#000" strokeOpacity=".28" vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
