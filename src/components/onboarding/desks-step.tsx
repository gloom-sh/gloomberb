import { Box, useUiCapabilities } from "../../ui";
import { t } from "../../i18n";
import { DESKS, deskFunctions, type DeskKey } from "../../layout/desks";
import { ToggleList } from "../toggle-list";

/** The most desks the step takes: the few someone trades most, not one of each. */
const MAX_DESK_PICKS = 3;

/**
 * Ticks or unticks a desk; the ticked ones keep the order they were ticked
 * in. A fourth tick is ignored: untick one first.
 */
export function toggleDeskChoice(chosen: DeskKey[], key: DeskKey): DeskKey[] {
  if (chosen.includes(key)) return chosen.filter((entry) => entry !== key);
  return chosen.length < MAX_DESK_PICKS ? [...chosen, key] : chosen;
}

/** "What do you trade most?": one checkbox per desk, with the functions it opens. */
export function DesksStep({
  chosen,
  cursor,
  onCursor,
  onToggle,
}: {
  chosen: readonly DeskKey[];
  cursor: number;
  onCursor: (index: number) => void;
  onToggle: (key: DeskKey) => void;
}) {
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const full = chosen.length >= MAX_DESK_PICKS;
  return (
    <Box flexDirection="column" flexShrink={0} paddingX={desktop ? 0 : 2} style={desktop ? { marginTop: 14 } : undefined}>
      <ToggleList
        items={DESKS.map((desk) => ({
          id: desk.key,
          label: t(desk.label),
          enabled: chosen.includes(desk.key),
          // Once three are ticked, the rest wait until one is unticked.
          disabled: full && !chosen.includes(desk.key),
          detail: deskFunctions(desk).join(" "),
        }))}
        selectedIdx={cursor}
        onSelect={onCursor}
        onToggle={(id) => onToggle(id as DeskKey)}
        showSelectedDescription={false}
        surface={desktop ? "framed" : undefined}
        remoteLabel="Desks"
      />
      {desktop ? null : <Box height={1} />}
    </Box>
  );
}
