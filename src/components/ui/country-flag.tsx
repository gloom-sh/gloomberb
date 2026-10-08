import { useId, type ReactNode } from "react";
import { useUiCapabilities } from "../../ui";

const FLAG_WIDTH = 30;
const FLAG_HEIGHT = 20;

const RED = "#c8102e";
const BLUE = "#012169";
const WHITE = "#ffffff";
const GOLD = "#ffcc00";

/** A star as an SVG path, tip up. */
function star(cx: number, cy: number, outer: number, points = 5, inner = outer * (points === 5 ? 0.382 : 0.5)): string {
  const vertices: string[] = [];
  for (let index = 0; index < points * 2; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = (Math.PI * index) / points - Math.PI / 2;
    vertices.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${vertices.join("L")}Z`;
}

/** The Union Jack stretched over a box of any ratio, with its counterchanged diagonals. */
function UnionJack({ x, y, width, height }: { x: number; y: number; width: number; height: number }) {
  const id = useId();
  const diagonals = "M0,0 60,40M60,0 0,40";
  const cross = "M30,0V40M0,20H60";
  return (
    <svg x={x} y={y} width={width} height={height} viewBox="0 0 60 40" preserveAspectRatio="none">
      <clipPath id={id}><path d="M30,20h30v20zv20h-30zh-30v-20zv-20h30z" /></clipPath>
      <rect width="60" height="40" fill={BLUE} />
      <path d={diagonals} stroke={WHITE} strokeWidth="8" />
      <path d={diagonals} stroke={RED} strokeWidth="5.3" clipPath={`url(#${id})`} />
      <path d={cross} stroke={WHITE} strokeWidth="13.3" />
      <path d={cross} stroke={RED} strokeWidth="8" />
    </svg>
  );
}

const US_STRIPES = [0, 2, 4, 6].map((index) => `M0,${(index * FLAG_HEIGHT) / 7}h${FLAG_WIDTH}v${FLAG_HEIGHT / 7}h-${FLAG_WIDTH}z`).join("");
const US_STARS = [2.2, 5.6, 9].flatMap((cy) => [2.5, 6.5, 10.5].map((cx) => star(cx, cy, 1.15))).join("");
const EU_STARS = Array.from({ length: 12 }, (_, index) => {
  const angle = (Math.PI * index) / 6;
  return star(15 + 6.6 * Math.sin(angle), 10 - 6.6 * Math.cos(angle), 1.5);
}).join("");
const MAPLE_LEAF = "M50,0 59,22 71,15 68,40 90,25 85,52 100,55 74,76 78,85 54,81 54,100H46L46,81 22,85 26,76 0,55 15,52 10,25 32,40 29,15 41,22Z";
const CROSS_STARS = [
  star(22.5, 3.2, 1.9, 7), star(18.3, 8.6, 1.9, 7), star(26.6, 7.4, 1.9, 7), star(22.5, 16.4, 1.9, 7), star(24.6, 11.2, 1),
].join("");
const NZ_STARS = [[22.5, 3.6], [18.3, 9], [26.6, 7.6], [22.5, 16.4]]
  .map(([cx, cy]) => star(cx!, cy!, 2.2)).join("");

/**
 * Hand-drawn at the size they are shown, the way a table shows them: a little
 * simpler than the real thing (7 stripes, a ring of dots) so each stays
 * recognisable at 18 by 12 pixels. Keyed by region, so the euro is the EU's.
 */
const FLAG_ART: Record<string, ReactNode> = {
  US: (
    <>
      <rect width={FLAG_WIDTH} height={FLAG_HEIGHT} fill={WHITE} />
      <path d={US_STRIPES} fill="#b22234" />
      <rect width="13.5" height={(FLAG_HEIGHT * 4) / 7} fill="#3c3b6e" />
      <path d={US_STARS} fill={WHITE} />
    </>
  ),
  EU: (
    <>
      <rect width={FLAG_WIDTH} height={FLAG_HEIGHT} fill="#003399" />
      <path d={EU_STARS} fill={GOLD} />
    </>
  ),
  GB: <UnionJack x={0} y={0} width={FLAG_WIDTH} height={FLAG_HEIGHT} />,
  JP: (
    <>
      <rect width={FLAG_WIDTH} height={FLAG_HEIGHT} fill={WHITE} />
      <circle cx="15" cy="10" r="6" fill="#bc002d" />
    </>
  ),
  CH: (
    <>
      <rect width={FLAG_WIDTH} height={FLAG_HEIGHT} fill="#d52b1e" />
      <path d="M15,3.6V16.4M8.6,10H21.4" stroke={WHITE} strokeWidth="4.2" />
    </>
  ),
  CA: (
    <>
      <rect width={FLAG_WIDTH} height={FLAG_HEIGHT} fill={WHITE} />
      <path d="M0,0h7.5v20h-7.5zM22.5,0h7.5v20h-7.5z" fill="#d52b1e" />
      <path d={MAPLE_LEAF} fill="#d52b1e" transform="translate(9.2 4.2) scale(.116)" />
    </>
  ),
  AU: (
    <>
      <rect width={FLAG_WIDTH} height={FLAG_HEIGHT} fill={BLUE} />
      <UnionJack x={0} y={0} width={15} height={10} />
      <path d={`${star(7.5, 15.2, 2.8, 7)}${CROSS_STARS}`} fill={WHITE} />
    </>
  ),
  NZ: (
    <>
      <rect width={FLAG_WIDTH} height={FLAG_HEIGHT} fill={BLUE} />
      <UnionJack x={0} y={0} width={15} height={10} />
      <path d={NZ_STARS} fill={RED} stroke={WHITE} strokeWidth=".55" />
    </>
  ),
};

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
