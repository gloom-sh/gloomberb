import { useRef, useState } from "react";
import { Button, Notice, NumberField, SelectButton, TextField, useFieldRing, type SelectControl } from "../../../components";
import { useInputCapture, useShortcut } from "../../../public/react";
import { Box, ScrollBox, type ScrollBoxRenderable } from "../../../ui";
import { useDialogState } from "../../../ui/dialog";
import type { ExposureScenario } from "../../../api-client/exposure";
import { parseCustomScenario } from "./model";

export interface ExposureInputs { input: string; source: string; nav: string; cash: string; depth: number; scenario: ExposureScenario; }
export function ExposureEditor({ initial, sources, focused, width, onSave, onCancel }: {
  initial: ExposureInputs; sources: { value: string; label: string }[]; focused: boolean; width: number;
  onSave: (value: ExposureInputs) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const first = initial.scenario.shocks[0]!;
  const [custom, setCustom] = useState(initial.scenario.shocks.length > 1 || !!first.transmission ? JSON.stringify(initial.scenario) : "");
  const [label, setLabel] = useState(initial.scenario.label);
  const [kind, setKind] = useState(first.kind);
  const [target, setTarget] = useState(first.target);
  const [size, setSize] = useState(String(first.changeBps ?? first.changePct ?? -100));
  const [products, setProducts] = useState(first.products?.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);
  const ids = ["source", "input", "nav", "cash", "depth", "label", "kind", "target", "size", "products", "custom", "save", "cancel"] as const;
  type Id = typeof ids[number];
  const [active, setActive] = useState<Id>("input");
  const sourceControl = useRef<SelectControl>(null), kindControl = useRef<SelectControl>(null), depthControl = useRef<SelectControl>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const dialogOpen = useDialogState(s => s.isOpen);
  const submit = () => {
    try {
      const scenario = parseCustomScenario(custom.trim() || JSON.stringify({ label, shocks: [{ id: "custom", kind, target, ...(kind === "rate" ? { changeBps: Number(size) } : { changePct: Number(size) }), ...(products.trim() ? { products: products.split(",").map(p => p.trim()).filter(Boolean) } : {}) }] }));
      if (!size.trim() && !custom.trim()) throw new Error("Enter a shock size.");
      if (draft.cash.trim() && (!Number.isFinite(Number(draft.cash)) || Math.abs(Number(draft.cash)) > 10)) throw new Error("Cash must be a NAV fraction between -10 and 10, for example 0.1.");
      onSave({ ...draft, scenario });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const ring = useFieldRing({ ids, activeId: active, onActivate: setActive, enabled: focused && !dialogOpen, scope: "exposure-editor", scrollRef,
    actions: { source: () => sourceControl.current?.open(), kind: () => kindControl.current?.open(), depth: () => depthControl.current?.open(), save: submit, cancel: onCancel } });
  useInputCapture(focused);
  useShortcut(e => { if (e.name === "escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }, { enabled: focused && !dialogOpen, phase: "before", allowEditable: true, scope: "exposure-editor" });
  const fieldWidth = Math.max(20, width - 4);
  const text = (id: Id, title: string, value: string, change: (v: string) => void, numeric = false) => {
    const props = { label: title, value, onChange: change, width: fieldWidth, focused: focused && active === id, active: active === id, onMouseDown: () => setActive(id), onSubmit: submit };
    return <Box ref={ring.nodeRef(id)}>{numeric ? <NumberField {...props} allowNegative /> : <TextField {...props} />}</Box>;
  };
  return <ScrollBox ref={scrollRef} flexGrow={1} flexBasis={0} minHeight={0} scrollY><Box paddingX={1} flexDirection="column" gap={1}>
    <Box ref={ring.nodeRef("source")}><SelectButton label="Holdings source" value={draft.source} options={sources} onChange={source => setDraft(d => ({ ...d, source }))} controlRef={sourceControl} onFocus={() => setActive("source")} emphasized={active === "source"} /></Box>
    {text("input", "Tickers / signed NAV weights", draft.input, input => setDraft(d => ({ ...d, input })))}
    {text("nav", "Portfolio NAV (portfolio currency)", draft.nav, nav => setDraft(d => ({ ...d, nav })), true)}
    {text("cash", "Cash weight (NAV fraction, optional)", draft.cash, cash => setDraft(d => ({ ...d, cash })), true)}
    <Box ref={ring.nodeRef("depth")}><SelectButton label="Relationship depth" value={String(draft.depth)} options={[1, 2, 3, 4].map(n => ({ value: String(n), label: String(n) }))} onChange={depth => setDraft(d => ({ ...d, depth: Number(depth) }))} controlRef={depthControl} onFocus={() => setActive("depth")} emphasized={active === "depth"} /></Box>
    {text("label", "Scenario name", label, setLabel)}
    <Box ref={ring.nodeRef("kind")}><SelectButton label="Shock kind" value={kind} options={["country", "supplier", "customer", "commodity", "rate", "fx", "tariff"].map(value => ({ value, label: value }))} onChange={value => setKind(value as typeof kind)} controlRef={kindControl} onFocus={() => setActive("kind")} emphasized={active === "kind"} /></Box>
    {text("target", "Country / entity / commodity / currency", target, setTarget)}
    {text("size", kind === "rate" ? "Rate change (basis points)" : "Shock change (%)", size, setSize, true)}
    {text("products", "Product restriction (comma separated, optional)", products, setProducts)}
    {text("custom", "Advanced scenario JSON (overrides fields above)", custom, setCustom)}
    {error ? <Notice tone="warning">{error}</Notice> : null}
    <Box flexDirection="row" gap={2}><Box ref={ring.nodeRef("save")}><Button label="Analyze" variant="primary" onPress={submit} /></Box><Box ref={ring.nodeRef("cancel")}><Button label="Cancel" variant="secondary" onPress={onCancel} /></Box></Box>
  </Box></ScrollBox>;
}
