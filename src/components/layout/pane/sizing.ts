
const PANE_HEADER_ROWS = 1;
const PANE_FOOTER_ROWS = 1;

const NATIVE_PANE_BODY_LAYOUT_PROPS = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: 0,
  minWidth: 0,
  minHeight: 0,
} as const;

export function shouldReservePaneFooter(nativePaneChrome: boolean | undefined, _showFooter: boolean): boolean {
  return !nativePaneChrome;
}

function resolvePaneBodyHeight({
  height,
  nativePaneChrome,
  footerVisible,
  reserveFooter = true,
  headerRows = PANE_HEADER_ROWS,
}: {
  height: number;
  nativePaneChrome?: boolean;
  footerVisible?: boolean;
  reserveFooter?: boolean;
  headerRows?: number;
}): number {
  const finiteHeight = Number.isFinite(height) ? height : 1;
  const normalizedHeight = nativePaneChrome ? finiteHeight : Math.max(1, Math.floor(finiteHeight));
  const footerRows = nativePaneChrome
    ? footerVisible ? PANE_FOOTER_ROWS : 0
    : reserveFooter ? PANE_FOOTER_ROWS : 0;
  return Math.max(1, normalizedHeight - headerRows - footerRows);
}

function getPaneBodyLayoutProps(nativePaneChrome: boolean | undefined, bodyHeight: number | undefined) {
  if (nativePaneChrome) return NATIVE_PANE_BODY_LAYOUT_PROPS;
  return {
    height: bodyHeight,
    flexGrow: bodyHeight == null ? 1 : 0,
    flexBasis: bodyHeight == null ? 0 : undefined,
    // Terminal focus borders occupy the outer columns. Keep every pane's
    // content inside them, including while focus moves between panes.
    paddingX: 1,
  };
}

export function resolvePaneBodyFrame({
  width,
  height,
  nativePaneChrome,
  footerVisible,
  reserveFooter = true,
  headerRows = PANE_HEADER_ROWS,
}: {
  width?: number;
  height?: number;
  nativePaneChrome?: boolean;
  footerVisible?: boolean;
  reserveFooter?: boolean;
  headerRows?: number;
}) {
  const bodyHeight = typeof height === "number"
    ? resolvePaneBodyHeight({ height, nativePaneChrome, footerVisible, reserveFooter, headerRows })
    : undefined;
  return {
    width: typeof width === "number" ? resolvePaneBodyWidth(width, nativePaneChrome) : undefined,
    height: bodyHeight,
    layoutProps: getPaneBodyLayoutProps(nativePaneChrome, bodyHeight),
  };
}

function resolvePaneBodyWidth(width: number, nativePaneChrome: boolean | undefined): number {
  const finiteWidth = Number.isFinite(width) ? width : 1;
  return nativePaneChrome ? Math.max(1, finiteWidth) : Math.max(1, Math.floor(finiteWidth) - 2);
}
