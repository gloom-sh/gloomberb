import { useRef, useState } from "react";
import { Button, Notice, NumberField, SelectButton, useFieldRing, type SelectControl } from "../../../components";
import { useInputCapture, useShortcut } from "../../../public/react";
import { Box, ScrollBox, type ScrollBoxRenderable } from "../../../ui";
import { useDialogState } from "../../../ui/dialog";
import { LIVE_SCAN_WINDOWS, type LiveScanCondition } from "../../../api-client/live-scan";
import { readCondition } from "./live-model";

type Kind = LiveScanCondition["kind"];

const KIND_OPTIONS: Array<{ value: Kind; label: string }> = [
  { value: "move", label: "Price move" },
  { value: "volume_spike", label: "Volume spike" },
  { value: "new_high", label: "New session high" },
  { value: "new_low", label: "New session low" },
  { value: "vwap_cross", label: "VWAP cross" },
  { value: "gap", label: "Gap from previous close" },
];
const WINDOW_OPTIONS = LIVE_SCAN_WINDOWS.map((window) => ({ value: String(window), label: `${window} min` }));
const VOLUME_WINDOW_OPTIONS = [...WINDOW_OPTIONS, { value: "day", label: "Session so far" }];
const MOVE_DIRECTIONS = [
  { value: "either", label: "Either way" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
];
const VWAP_DIRECTIONS = [
  { value: "either", label: "Either way" },
  { value: "above", label: "Above" },
  { value: "below", label: "Below" },
];

interface Draft {
  kind: Kind;
  window: string;
  direction: string;
  amount: string;
}

function draftOf(condition: LiveScanCondition | null): Draft {
  if (!condition) return { kind: "move", window: "5", direction: "either", amount: "2" };
  switch (condition.kind) {
    case "move":
      return { kind: "move", window: String(condition.window), direction: condition.direction, amount: String(condition.percent) };
    case "volume_spike":
      return { kind: "volume_spike", window: String(condition.window), direction: "either", amount: String(condition.ratio) };
    case "new_high":
    case "new_low":
      return { kind: condition.kind, window: String(condition.within), direction: "either", amount: "" };
    case "vwap_cross":
      return { kind: "vwap_cross", window: String(condition.within), direction: condition.direction, amount: "" };
    case "gap":
      return { kind: "gap", window: "5", direction: condition.direction, amount: String(condition.percent) };
  }
}

/** The condition a draft describes, or why it does not describe one. */
function conditionFromDraft(draft: Draft): LiveScanCondition | string {
  const amount = Number(draft.amount);
  const window = draft.window === "day" ? "day" : Number(draft.window);
  const needsAmount = draft.kind === "move" || draft.kind === "gap" || draft.kind === "volume_spike";
  if (needsAmount && (!draft.amount.trim() || !Number.isFinite(amount))) {
    return draft.kind === "volume_spike" ? "Enter a multiple of average volume, such as 3." : "Enter a percent, such as 2.";
  }
  if (draft.kind === "volume_spike" && amount < 0.1) return "A volume multiple starts at 0.1.";
  if (needsAmount && amount > 1_000) return "That is more than the scanner takes.";
  const raw = draft.kind === "move"
    ? { kind: "move", window, direction: draft.direction, percent: amount }
    : draft.kind === "volume_spike"
      ? { kind: "volume_spike", window, ratio: amount }
      : draft.kind === "gap"
        ? { kind: "gap", direction: draft.direction, percent: amount }
        : draft.kind === "vwap_cross"
          ? { kind: "vwap_cross", direction: draft.direction, within: window }
          : { kind: draft.kind, within: window };
  return readCondition(raw) ?? "Check the window and direction.";
}

const FIELD_IDS = ["kind", "window", "direction", "amount", "save", "cancel"] as const;
type FieldId = (typeof FIELD_IDS)[number];

export function LiveConditionEditor({
  value,
  focused,
  width,
  onSave,
  onCancel,
}: {
  value: LiveScanCondition | null;
  focused: boolean;
  width: number;
  onSave: (condition: LiveScanCondition) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(value));
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<FieldId>("kind");
  const kindControl = useRef<SelectControl>(null);
  const windowControl = useRef<SelectControl>(null);
  const directionControl = useRef<SelectControl>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const dialogOpen = useDialogState((state) => state.isOpen);
  const hasWindow = draft.kind !== "gap";
  const hasDirection = draft.kind === "move" || draft.kind === "gap" || draft.kind === "vwap_cross";
  const hasAmount = draft.kind === "move" || draft.kind === "gap" || draft.kind === "volume_spike";
  const ids = FIELD_IDS.filter((id) => (
    (id !== "window" || hasWindow) && (id !== "direction" || hasDirection) && (id !== "amount" || hasAmount)
  ));
  const save = () => {
    const condition = conditionFromDraft(draft);
    if (typeof condition === "string") setError(condition);
    else onSave(condition);
  };
  const ring = useFieldRing<FieldId>({
    ids,
    activeId: active,
    onActivate: setActive,
    enabled: focused && !dialogOpen,
    scope: "live-scan-condition",
    scrollRef,
    actions: {
      kind: () => kindControl.current?.open(),
      window: () => windowControl.current?.open(),
      direction: () => directionControl.current?.open(),
      save,
      cancel: onCancel,
    },
  });
  useInputCapture(focused);
  useShortcut((event) => {
    if (event.name !== "escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  }, { enabled: focused && !dialogOpen, phase: "before", allowEditable: true, scope: "live-scan-condition" });
  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };
  const fieldWidth = Math.max(20, Math.min(44, width - 4));
  const windowLabel = draft.kind === "move" || draft.kind === "volume_spike" ? "Over the last" : "Within the last";
  const amountLabel = draft.kind === "volume_spike" ? "Times average volume" : "Percent, at least";
  return (
    <ScrollBox ref={scrollRef} flexGrow={1} flexBasis={0} minHeight={0} scrollY>
      <Box paddingX={1} flexDirection="column" gap={1}>
        <Box ref={ring.nodeRef("kind")}>
          <SelectButton
            variant="form"
            width={fieldWidth}
            label="Condition"
            value={draft.kind}
            options={KIND_OPTIONS}
            onChange={(kind) => {
              const next = draftOf(null);
              update({
                kind,
                direction: kind === draft.kind ? draft.direction : "either",
                window: kind === "volume_spike" || draft.window !== "day" ? draft.window : "5",
                amount: kind === "volume_spike" ? "3" : kind === "move" || kind === "gap" ? next.amount : "",
              });
            }}
            controlRef={kindControl}
            onFocus={() => setActive("kind")}
            emphasized={active === "kind"}
          />
        </Box>
        {hasWindow ? (
          <Box ref={ring.nodeRef("window")}>
            <SelectButton
              variant="form"
              width={fieldWidth}
              label={windowLabel}
              value={draft.window}
              options={draft.kind === "volume_spike" ? VOLUME_WINDOW_OPTIONS : WINDOW_OPTIONS}
              onChange={(window) => update({ window })}
              controlRef={windowControl}
              onFocus={() => setActive("window")}
              emphasized={active === "window"}
            />
          </Box>
        ) : null}
        {hasDirection ? (
          <Box ref={ring.nodeRef("direction")}>
            <SelectButton
              variant="form"
              width={fieldWidth}
              label="Direction"
              value={draft.direction}
              options={draft.kind === "vwap_cross" ? VWAP_DIRECTIONS : MOVE_DIRECTIONS}
              onChange={(direction) => update({ direction })}
              controlRef={directionControl}
              onFocus={() => setActive("direction")}
              emphasized={active === "direction"}
            />
          </Box>
        ) : null}
        {hasAmount ? (
          <Box ref={ring.nodeRef("amount")}>
            <NumberField
              label={amountLabel}
              value={draft.amount}
              onChange={(amount) => update({ amount })}
              onSubmit={save}
              width={fieldWidth}
              focused={focused && active === "amount"}
              active={active === "amount"}
              onMouseDown={() => setActive("amount")}
            />
          </Box>
        ) : null}
        {error ? <Notice tone="negative">{error}</Notice> : null}
        <Box flexDirection="row" gap={1}>
          <Box ref={ring.nodeRef("save")}>
            <Button label="Save condition" variant="primary" active={focused && active === "save"} onPress={save} />
          </Box>
          <Box ref={ring.nodeRef("cancel")}>
            <Button label="Cancel" variant="secondary" active={focused && active === "cancel"} onPress={onCancel} />
          </Box>
        </Box>
      </Box>
    </ScrollBox>
  );
}
