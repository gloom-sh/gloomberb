import { useId, type ReactNode } from "react";

export const FLAG_WIDTH = 30;
export const FLAG_HEIGHT = 20;

const RED = "#c8102e";
const BLUE = "#012169";
const WHITE = "#ffffff";
const GOLD = "#ffcc00";
const BLACK = "#000000";

/** A star as an SVG path, tip up unless rotated clockwise by `rotate` degrees. */
function star(
  cx: number,
  cy: number,
  outer: number,
  points = 5,
  inner = outer * (points === 5 ? 0.382 : 0.5),
  rotate = 0,
): string {
  const vertices: string[] = [];
  for (let index = 0; index < points * 2; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = (Math.PI * index) / points - Math.PI / 2 + (rotate * Math.PI) / 180;
    vertices.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${vertices.join("L")}Z`;
}

/** A triangle as an SVG path, apex up unless rotated clockwise by `rotate` degrees. */
function triangle(cx: number, cy: number, radius: number, rotate = 0): string {
  return `M${[0, 1, 2].map((index) => {
    const angle = (index * 2 * Math.PI) / 3 - Math.PI / 2 + (rotate * Math.PI) / 180;
    return `${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`;
  }).join("L")}Z`;
}

/** A solid background under every flag. */
function Field({ fill }: { fill: string }) {
  return <rect width={FLAG_WIDTH} height={FLAG_HEIGHT} fill={fill} />;
}

/** Equal (or weighted) bands, top to bottom or left to right. */
function Bands({ colors, vertical = false, weights }: { colors: readonly string[]; vertical?: boolean; weights?: readonly number[] }) {
  const total = weights ? weights.reduce((sum, weight) => sum + weight, 0) : colors.length;
  const length = vertical ? FLAG_WIDTH : FLAG_HEIGHT;
  let offset = 0;
  return (
    <>
      {colors.map((fill, index) => {
        const size = ((weights?.[index] ?? 1) / total) * length;
        const start = offset;
        offset += size;
        return vertical
          ? <rect key={index} x={start} width={size + 0.02} height={FLAG_HEIGHT} fill={fill} />
          : <rect key={index} y={start} width={FLAG_WIDTH} height={size + 0.02} fill={fill} />;
      })}
    </>
  );
}

/** A crescent facing right: a disc with a bite of the background colour taken from its right. */
function Crescent({ cx, cy, r, bite, shift, fill, back }: {
  cx: number; cy: number; r: number; bite: number; shift: number; fill: string; back: string;
}) {
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill={fill} />
      <circle cx={cx + shift} cy={cy} r={bite} fill={back} />
    </>
  );
}

/** A Nordic cross whose vertical bar sits `x` from the hoist. */
function NordicCross({ x, thickness, fill }: { x: number; thickness: number; fill: string }) {
  const y = (FLAG_HEIGHT - thickness) / 2;
  return <path d={`M${x},0h${thickness}v${FLAG_HEIGHT}h-${thickness}zM0,${y}h${FLAG_WIDTH}v${thickness}h-${FLAG_WIDTH}z`} fill={fill} />;
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

/** One South Korean trigram: three bars stacked along the flag's diagonal, solid or broken. */
function Trigram({ cx, cy, tilt, lines }: { cx: number; cy: number; tilt: number; lines: readonly boolean[] }) {
  return (
    <g transform={`translate(${cx} ${cy}) rotate(${tilt})`} fill={BLACK}>
      {lines.map((solid, index) => {
        const y = (index - 1) * 1.75 - 0.5;
        return solid
          ? <rect key={index} x="-2.6" y={y} width="5.2" height="1.05" />
          : <path key={index} d={`M-2.6,${y}h2.05v1.05h-2.05zM0.55,${y}h2.05v1.05h-2.05z`} />;
      })}
    </g>
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

/** Straight rays round a disc, for the suns on the Philippine, Argentine, Taiwanese and Kazakh flags. */
function sunRays(cx: number, cy: number, inner: number, outer: number, count: number, offset = 0): string {
  return Array.from({ length: count }, (_, index) => {
    const angle = ((index + offset) * 2 * Math.PI) / count;
    return `M${(cx + inner * Math.cos(angle)).toFixed(2)},${(cy + inner * Math.sin(angle)).toFixed(2)}L${(cx + outer * Math.cos(angle)).toFixed(2)},${(cy + outer * Math.sin(angle)).toFixed(2)}`;
  }).join("");
}

/** A row of points along a vertical edge, for the serrated Qatari hoist. */
const QA_SERRATION = `M0,0H9${Array.from({ length: 9 }, (_, index) => {
  const top = (index * FLAG_HEIGHT) / 9;
  const step = FLAG_HEIGHT / 9;
  return `L11.6,${(top + step / 2).toFixed(2)}L9,${(top + step).toFixed(2)}`;
}).join("")}H0Z`;

const HK_PETALS = Array.from({ length: 5 }, (_, index) => (
  <ellipse key={index} cx="15" cy="6.9" rx="1.9" ry="3.2" fill={WHITE} transform={`rotate(${index * 72} 15 10)`} />
));

const MY_STRIPES = [1, 3, 5].map((index) => `M0,${(index * FLAG_HEIGHT) / 7}h${FLAG_WIDTH}v${FLAG_HEIGHT / 7}h-${FLAG_WIDTH}z`).join("");

/**
 * Hand-drawn at the size they are shown, the way a table shows them: a little
 * simpler than the real thing (7 stripes, a ring of dots) so each stays
 * recognisable at 18 by 12 pixels. Keyed by region, so the euro is the EU's and
 * both yuan are China's.
 */
export const FLAG_ART: Record<string, ReactNode> = {
  US: (
    <>
      <Field fill={WHITE} />
      <path d={US_STRIPES} fill="#b22234" />
      <rect width="13.5" height={(FLAG_HEIGHT * 4) / 7} fill="#3c3b6e" />
      <path d={US_STARS} fill={WHITE} />
    </>
  ),
  EU: (
    <>
      <Field fill="#003399" />
      <path d={EU_STARS} fill={GOLD} />
    </>
  ),
  GB: <UnionJack x={0} y={0} width={FLAG_WIDTH} height={FLAG_HEIGHT} />,
  JP: (
    <>
      <Field fill={WHITE} />
      <circle cx="15" cy="10" r="6" fill="#bc002d" />
    </>
  ),
  CH: (
    <>
      <Field fill="#d52b1e" />
      <path d="M15,3.6V16.4M8.6,10H21.4" stroke={WHITE} strokeWidth="4.2" />
    </>
  ),
  CA: (
    <>
      <Field fill={WHITE} />
      <path d="M0,0h7.5v20h-7.5zM22.5,0h7.5v20h-7.5z" fill="#d52b1e" />
      <path d={MAPLE_LEAF} fill="#d52b1e" transform="translate(9.2 4.2) scale(.116)" />
    </>
  ),
  AU: (
    <>
      <Field fill={BLUE} />
      <UnionJack x={0} y={0} width={15} height={10} />
      <path d={`${star(7.5, 15.2, 2.8, 7)}${CROSS_STARS}`} fill={WHITE} />
    </>
  ),
  NZ: (
    <>
      <Field fill={BLUE} />
      <UnionJack x={0} y={0} width={15} height={10} />
      <path d={NZ_STARS} fill={RED} stroke={WHITE} strokeWidth=".55" />
    </>
  ),

  // The other liquid currencies.
  SE: (
    <>
      <Field fill="#006aa7" />
      <NordicCross x={9.4} thickness={4} fill="#fecc02" />
    </>
  ),
  NO: (
    <>
      <Field fill="#ba0c2f" />
      <NordicCross x={8} thickness={6} fill={WHITE} />
      <NordicCross x={9.6} thickness={2.8} fill="#00205b" />
    </>
  ),
  DK: (
    <>
      <Field fill="#c8102e" />
      <NordicCross x={9.5} thickness={3.6} fill={WHITE} />
    </>
  ),
  HK: (
    <>
      <Field fill="#de2910" />
      {HK_PETALS}
    </>
  ),
  SG: (
    <>
      <Bands colors={["#ef3340", WHITE]} />
      <Crescent cx={6.6} cy={5} r={3.9} bite={3.3} shift={1.5} fill={WHITE} back="#ef3340" />
      <path
        d={[0, 1, 2, 3, 4].map((index) => {
          const angle = (index * 2 * Math.PI) / 5 - Math.PI / 2;
          return star(11.4 + 2.25 * Math.cos(angle), 5 + 2.25 * Math.sin(angle), 0.95);
        }).join("")}
        fill={WHITE}
      />
    </>
  ),
  CN: (
    <>
      <Field fill="#de2910" />
      <path d={star(5.6, 5.3, 3.2)} fill="#ffde00" />
      <path
        d={[[10.8, 2.1, 20], [12.7, 4.4, 45], [12.7, 7.4, 70], [10.8, 9.7, 95]]
          .map(([cx, cy, rotate]) => star(cx!, cy!, 1.15, 5, undefined, rotate))
          .join("")}
        fill="#ffde00"
      />
    </>
  ),

  // Asia.
  KR: (
    <>
      <Field fill={WHITE} />
      <g transform="translate(15 10) rotate(-33.7)">
        <circle r="5" fill="#cd2e3a" />
        <path d="M-5,0a5,5 0 0 0 10,0a2.5,2.5 0 0 0 -5,0a2.5,2.5 0 0 1 -5,0z" fill="#0047a0" />
      </g>
      <Trigram cx={6.4} cy={4.4} tilt={-56.3} lines={[true, true, true]} />
      <Trigram cx={23.6} cy={15.6} tilt={-56.3} lines={[false, false, false]} />
      <Trigram cx={23.6} cy={4.4} tilt={56.3} lines={[false, true, false]} />
      <Trigram cx={6.4} cy={15.6} tilt={56.3} lines={[true, false, true]} />
    </>
  ),
  TW: (
    <>
      <Field fill="#fe0000" />
      <rect width="15" height="10" fill="#000095" />
      <path d={star(7.5, 5, 4.1, 12, 2.6)} fill={WHITE} />
      <circle cx="7.5" cy="5" r="1.9" fill="#000095" />
      <circle cx="7.5" cy="5" r="1.5" fill={WHITE} />
    </>
  ),
  IN: (
    <>
      <Bands colors={["#ff9933", WHITE, "#138808"]} />
      <circle cx="15" cy="10" r="2.5" fill="none" stroke="#000080" strokeWidth=".6" />
      <path d={sunRays(15, 10, 0, 2.5, 12)} stroke="#000080" strokeWidth=".45" />
      <circle cx="15" cy="10" r=".7" fill="#000080" />
    </>
  ),
  ID: <Bands colors={["#ce1126", WHITE]} />,
  MY: (
    <>
      <Field fill={WHITE} />
      <path d={`M0,0h${FLAG_WIDTH}v${FLAG_HEIGHT / 7}h-${FLAG_WIDTH}z${MY_STRIPES}M0,${(6 * FLAG_HEIGHT) / 7}h${FLAG_WIDTH}v${FLAG_HEIGHT / 7}h-${FLAG_WIDTH}z`} fill="#cc0001" />
      <rect width="15" height={(4 * FLAG_HEIGHT) / 7} fill="#010066" />
      <Crescent cx={6.1} cy={5.7} r={3.7} bite={3} shift={1.3} fill="#ffcc00" back="#010066" />
      <path d={star(10, 5.7, 2.7, 14, 1.4)} fill="#ffcc00" />
    </>
  ),
  PH: (
    <>
      <Bands colors={["#0038a8", "#ce1126"]} />
      <path d="M0,0L17.3,10L0,20Z" fill={WHITE} />
      <circle cx="5.2" cy="10" r="1.9" fill="#fcd116" />
      <path d={sunRays(5.2, 10, 2.4, 3.6, 8, 0.5)} stroke="#fcd116" strokeWidth=".7" />
      <path d={[[1.9, 3.1], [1.9, 16.9], [13.2, 10]].map(([cx, cy]) => star(cx!, cy!, 1.45)).join("")} fill="#fcd116" />
    </>
  ),
  TH: <Bands colors={["#a51931", WHITE, "#2d2a4a", WHITE, "#a51931"]} weights={[1, 1, 2, 1, 1]} />,
  VN: (
    <>
      <Field fill="#da251d" />
      <path d={star(15, 10.5, 6.3)} fill="#ffff00" />
    </>
  ),
  PK: (
    <>
      <Field fill="#01411c" />
      <rect width="7.5" height="20" fill={WHITE} />
      <Crescent cx={18.4} cy={10.4} r={5.2} bite={4.3} shift={1.7} fill={WHITE} back="#01411c" />
      <path d={star(21.9, 7.7, 1.9, 5, undefined, 20)} fill={WHITE} />
    </>
  ),

  // Europe, the Middle East and Africa.
  PL: <Bands colors={[WHITE, "#dc143c"]} />,
  CZ: (
    <>
      <Bands colors={[WHITE, "#d7141a"]} />
      <path d="M0,0L15,10L0,20Z" fill="#11457e" />
    </>
  ),
  HU: <Bands colors={["#ce2939", WHITE, "#477050"]} />,
  RO: <Bands colors={["#002b7f", "#fcd116", "#ce1126"]} vertical />,
  UA: <Bands colors={["#0057b8", "#ffd700"]} />,
  TR: (
    <>
      <Field fill="#e30a17" />
      <Crescent cx={10.6} cy={10} r={5.4} bite={4.3} shift={1.5} fill={WHITE} back="#e30a17" />
      <path d={star(16.4, 10, 2.5, 5, undefined, 90)} fill={WHITE} />
    </>
  ),
  KZ: (
    <>
      <Field fill="#00afca" />
      <path d="M0,0h2.6v20h-2.6z" fill="#fec50c" />
      <path d="M2.6,1.4L1.1,3.4L2.6,5.4M2.6,7.4L1.1,9.4L2.6,11.4M2.6,13.4L1.1,15.4L2.6,17.4" stroke="#00afca" strokeWidth=".7" fill="none" />
      <circle cx="16.3" cy="7" r="2.6" fill="#fec50c" />
      <path d={sunRays(16.3, 7, 3.3, 5.1, 16)} stroke="#fec50c" strokeWidth=".8" />
      <path d="M9.4,14.2C11.4,11.8 14,11.8 16.3,13.2C18.6,11.8 21.2,11.8 23.2,14.2C21,13.8 19,14.5 16.3,16.7C13.6,14.5 11.6,13.8 9.4,14.2Z" fill="#fec50c" />
    </>
  ),
  IL: (
    <>
      <Field fill={WHITE} />
      <path d="M0,2.4h30v2.8h-30zM0,14.8h30v2.8h-30z" fill="#0038b8" />
      <path d={`${triangle(15, 10, 3.8)}${triangle(15, 10, 3.8, 180)}`} fill="none" stroke="#0038b8" strokeWidth=".9" />
    </>
  ),
  SA: (
    <>
      <Field fill="#006c35" />
      <path
        d="M7,9.6C8,6.1 9.4,6.1 9.9,9.6M11.6,9.6C12.4,5.2 13.8,5.2 14.4,9.6M15.8,9.6V5.4M18.2,9.6C19,7 20.2,7 20.6,9.6C21.4,7.6 22.2,7.6 23,9.6M7,9.6H23"
        fill="none" stroke={WHITE} strokeWidth=".95" strokeLinecap="round" strokeLinejoin="round"
      />
      <path d="M6.6,14.4L19.2,13.6V15.2Z" fill={WHITE} />
      <path d="M19.2,12.6V16.2" stroke={WHITE} strokeWidth=".9" />
      <path d="M19.6,14.4H23.4" stroke={WHITE} strokeWidth="1.1" strokeLinecap="round" />
    </>
  ),
  AE: (
    <>
      <Bands colors={["#00732f", WHITE, BLACK]} />
      <rect width="7.6" height="20" fill="#ff0000" />
    </>
  ),
  QA: (
    <>
      <Field fill="#8a1538" />
      <path d={QA_SERRATION} fill={WHITE} />
    </>
  ),
  EG: (
    <>
      <Bands colors={["#ce1126", WHITE, BLACK]} />
      <path
        d="M15,7.7C15.7,7.7 16.2,8.2 16.2,8.8L18.4,7.8L17.6,10.2L18.1,12.2L16.4,11.8L15.8,12.8H14.2L13.6,11.8L11.9,12.2L12.4,10.2L11.6,7.8L13.8,8.8C13.8,8.2 14.3,7.7 15,7.7Z"
        fill="#c09300"
      />
    </>
  ),
  ZA: (
    <>
      <Bands colors={["#de3831", "#002395"]} />
      <path d="M-2,-2L10,10L-2,22M10,10H32" fill="none" stroke={WHITE} strokeWidth="5.8" />
      <path d="M-2,-2L10,10L-2,22M10,10H32" fill="none" stroke="#007749" strokeWidth="3.6" />
      <path d="M0,2.6L7.4,10L0,17.4Z" fill="#ffb612" />
      <path d="M0,4.5L4.6,10L0,15.5Z" fill={BLACK} />
    </>
  ),
  NG: <Bands colors={["#008751", WHITE, "#008751"]} vertical />,
  KE: (
    <>
      <Bands colors={[BLACK, WHITE, "#bb0000", WHITE, "#006600"]} weights={[5.5, 1.3, 6.4, 1.3, 5.5]} />
      <path d="M9.6,2.6L20.4,17.4M20.4,2.6L9.6,17.4" stroke={WHITE} strokeWidth=".9" />
      <ellipse cx="15" cy="10" rx="3.7" ry="6.2" fill="#bb0000" stroke={BLACK} strokeWidth=".9" />
      <ellipse cx="15" cy="10" rx="1.7" ry="3.6" fill={WHITE} />
      <path d="M13.3,8.4H16.7M13.3,10H16.7M13.3,11.6H16.7" stroke={BLACK} strokeWidth=".7" />
    </>
  ),

  // Latin America.
  MX: (
    <>
      <Bands colors={["#006847", WHITE, "#ce1126"]} vertical />
      <path d="M12.4,13.8C12.6,16 17.4,16 17.6,13.8" stroke="#006847" strokeWidth=".7" fill="none" />
      <path d="M15,6.3C15.8,6.3 16.3,6.8 16.2,7.5L18.3,7C17.8,8.3 17.1,9 16.2,9.3C16.4,10.2 16.1,11.1 15.5,11.7L16.1,13H13.9L14.5,11.7C13.9,11.1 13.6,10.2 13.8,9.3C12.9,9 12.2,8.3 11.7,7L13.8,7.5C13.7,6.8 14.2,6.3 15,6.3Z" fill="#8c5a25" />
      <path d="M12.8,12.6H17.2" stroke="#2e7d32" strokeWidth=".8" />
    </>
  ),
  BR: (
    <>
      <Field fill="#009c3b" />
      <path d="M15,1.8L27.4,10L15,18.2L2.6,10Z" fill="#ffdf00" />
      <circle cx="15" cy="10" r="4.8" fill="#002776" />
      <path d="M10.4,11.4C13.2,8.7 17.6,8.7 19.6,10.9" stroke={WHITE} strokeWidth=".95" fill="none" />
    </>
  ),
  CO: <Bands colors={["#fcd116", "#003893", "#ce1126"]} weights={[2, 1, 1]} />,
  CL: (
    <>
      <Bands colors={[WHITE, "#d52b1e"]} />
      <rect width="10" height="10" fill="#0039a6" />
      <path d={star(5, 5, 2.9)} fill={WHITE} />
    </>
  ),
  PE: (
    <>
      <Bands colors={["#d91023", WHITE, "#d91023"]} vertical />
      <path d="M12.9,6.9H17.1V10.6C17.1,12 16,12.9 15,13.4C14,12.9 12.9,12 12.9,10.6Z" fill="#d91023" stroke="#7a5a1a" strokeWidth=".45" />
      <path d="M12.9,6.9H15V10.2H12.9Z" fill="#8cc6ea" />
      <path d="M15,6.9H17.1V10.2H15Z" fill="#f3f3f3" />
      <path d="M15,7.5V10" stroke="#3a8f3a" strokeWidth=".8" />
      <path d="M12.3,7.5C12,10.2 12.7,12.6 15,14.2C17.3,12.6 18,10.2 17.7,7.5" stroke="#3a8f3a" strokeWidth=".55" fill="none" />
    </>
  ),
  AR: (
    <>
      <Bands colors={["#74acdf", WHITE, "#74acdf"]} />
      <circle cx="15" cy="10" r="2.1" fill="#f6b40e" />
      <path d={sunRays(15, 10, 2.6, 3.9, 16)} stroke="#f6b40e" strokeWidth=".7" />
    </>
  ),
};
