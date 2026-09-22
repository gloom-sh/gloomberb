import { useRef, useState } from "react";
import { Button, NumberField, TextField, SelectButton, Notice, type SelectControl } from "gloomberb/components";
import { useInputCapture, useShortcut } from "gloomberb/react";
import { Box, ScrollBox } from "gloomberb/ui";
import { parseScenarioInputFields } from "./state";
import { parseLegs, type ScenarioLeg, type ScenarioPosition, type ScenarioControls } from "./model";

export function ScenarioLegEditor({ leg, focused, width, onSave, onCancel }: {
  leg: ScenarioLeg; focused: boolean; width: number;
  onSave: (leg: ScenarioLeg) => void; onCancel: () => void;
}) {
  const [side, setSide] = useState(leg.side);
  const [direction, setDirection] = useState(leg.quantity < 0 ? "sell" : "buy");
  const [fields, setFields] = useState(() => ({ strike: String(leg.strike),
    expiration: new Date(leg.expiration * 1000).toISOString().slice(0, 10), quantity: String(Math.abs(leg.quantity)),
    price: String(leg.price), volatility: String(leg.volatility * 100), multiplier: String(leg.multiplier) }));
  type Field = keyof typeof fields;
  const fieldIds: Field[] = ["strike", "expiration", "quantity", "price", "volatility", "multiplier"];
  const [active, setActive] = useState<Field | "side" | "direction">("strike");
  const focusIds = [...fieldIds, "side", "direction"] as const;
  const sideControl = useRef<SelectControl>(null), directionControl = useRef<SelectControl>(null);
  const [error, setError] = useState<string | null>(null);
  useInputCapture(focused);
  const submit = () => {
    try {
      const parsed = parseLegs([side, fields.strike, fields.expiration,
        `${direction === "sell" ? "-" : ""}${fields.quantity}`, fields.price, fields.volatility, fields.multiplier].join(","))[0]!;
      onSave({ ...parsed, id: leg.id });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  useShortcut((event) => {
    if (event.name === "tab") {
      event.preventDefault(); event.stopPropagation();
      setActive((current) => focusIds[(focusIds.indexOf(current) + (event.shift ? -1 : 1) + focusIds.length) % focusIds.length]!);
    } else if (["enter", "return", "space"].includes(event.name ?? "") && (active === "side" || active === "direction")) {
      event.preventDefault(); event.stopPropagation();
      (active === "side" ? sideControl : directionControl).current?.open();
    } else if (event.name === "escape") {
      event.preventDefault(); event.stopPropagation(); onCancel();
    }
  }, { enabled: focused, phase: "before", allowEditable: true, scope: "osa-leg-form" });
  const labels: Record<Field, string> = { strike: "Strike", expiration: "Expiry (YYYY-MM-DD)",
    quantity: "Contracts", price: "Entry price / unit", volatility: "IV %", multiplier: "Units / contract" };
  const fieldWidth = Math.max(16, Math.min(32, Math.floor((width - 5) / 2)));
  return <ScrollBox scrollY flexGrow={1} flexBasis={0} minHeight={0}>
    <Box paddingX={1} flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={3}>
        <SelectButton label="Option" controlRef={sideControl} onFocus={() => setActive("side")} emphasized={active === "side"} value={side} onChange={(value) => setSide(value as ScenarioLeg["side"])}
          options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
        <SelectButton label="Position" controlRef={directionControl} onFocus={() => setActive("direction")} emphasized={active === "direction"} value={direction} onChange={setDirection}
          options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />
      </Box>
      {[0, 2, 4].map((offset) => <Box key={offset} flexDirection="row" gap={3}>
        {fieldIds.slice(offset, offset + 2).map((id) => {
          const props = { label: labels[id], width: fieldWidth, value: fields[id], focused: focused && active === id,
            onMouseDown: () => setActive(id), onChange: (value: string) => setFields((current) => ({ ...current, [id]: value })),
            onSubmit: submit };
          return id === "expiration" ? <TextField key={id} {...props} />
            : <NumberField key={id} {...props} allowDecimal={!["quantity", "multiplier"].includes(id)} />;
        })}
      </Box>)}
      {error && <Notice tone="warning">{error}</Notice>}
      <Box flexDirection="row" gap={2}>
        <Button label="Save leg" variant="primary" onPress={submit} />
        <Button label="Cancel" variant="secondary" onPress={onCancel} />
      </Box>
    </Box>
  </ScrollBox>;
}

export function ScenarioSaveForm({ focused, onSave, onCancel }: {
  focused: boolean; onSave: (name: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState("");
  useInputCapture(focused);
  useShortcut((event) => {
    if (event.name === "escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
  }, { enabled: focused, phase: "before", allowEditable: true, scope: "osa-save-form" });
  return <Box flexDirection="column" gap={1} paddingX={1}>
    <TextField label="Strategy name" width={34} value={name} onChange={setName} focused={focused}
      onSubmit={() => { if (name.trim()) onSave(name.trim()); }} />
    <Box flexDirection="row" gap={2}>
      <Button label="Save" variant="primary" disabled={!name.trim()} onPress={() => onSave(name.trim())} />
      <Button label="Cancel" variant="secondary" onPress={onCancel} />
    </Box>
  </Box>;
}

export function ScenarioInputsForm({ position, controls, focused, width, onSave, onCancel }: {
  position: ScenarioPosition; controls: ScenarioControls | null; focused: boolean; width: number;
  onSave: (position: ScenarioPosition, controls: ScenarioControls) => void; onCancel: () => void;
}) {
  const [fields, setFields] = useState({ spot: Number.isFinite(position.spot) ? String(position.spot) : "", rate: Number.isFinite(position.rate) ? String(position.rate * 100) : "",
    dividendYield: Number.isFinite(position.dividendYield) ? String(position.dividendYield * 100) : "", currency: position.currency,
    asOf: Number.isFinite(new Date(position.asOf).getTime()) ? new Date(position.asOf).toISOString() : "", spotRange: String((controls?.spotRange ?? .3) * 100) });
  type Field = keyof typeof fields;
  const keys: Field[] = ["spot", "rate", "dividendYield", "currency", "asOf", "spotRange"];
  const [active, setActive] = useState<Field>("spot");
  const [error, setError] = useState<string | null>(null);
  useInputCapture(focused);
  const submit = () => {
    try {
      const result = parseScenarioInputFields(position, fields, controls);
      onSave(result.position, result.controls);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  useShortcut((event) => {
    if (event.name === "tab") {
      event.preventDefault(); event.stopPropagation();
      setActive((current) => keys[(keys.indexOf(current) + (event.shift ? -1 : 1) + keys.length) % keys.length]!);
    } else if (event.name === "escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
  }, { enabled: focused, phase: "before", allowEditable: true, scope: "osa-input-form" });
  const labels = { spot: "Underlying spot", rate: "Rate %", dividendYield: "Dividend yield %", currency: "Currency",
    asOf: "Valuation timestamp (UTC)", spotRange: "Spot range %" };
  return <ScrollBox scrollY flexGrow={1} flexBasis={0} minHeight={0}>
    <Box flexDirection="column" paddingX={1} gap={1}>
      {keys.map((key) => {
        const props = { label: labels[key], value: fields[key], width: Math.min(34, width - 2), focused: focused && active === key,
          onMouseDown: () => setActive(key), onChange: (value: string) => setFields((current) => ({ ...current, [key]: value })), onSubmit: submit };
        return key === "asOf" || key === "currency" ? <TextField key={key} {...props} />
          : <NumberField key={key} {...props} allowNegative={key === "rate" || key === "dividendYield"} />;
      })}
      {error && <Notice>{error}</Notice>}
      <Box flexDirection="row" gap={2}><Button label="Apply inputs" variant="primary" onPress={submit} />
        <Button label="Cancel" variant="secondary" onPress={onCancel} /></Box>
    </Box>
  </ScrollBox>;
}
