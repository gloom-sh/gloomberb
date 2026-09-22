import { useRef, useState } from "react";
import { Box } from "../../../ui";
import {
  Button,
  Notice,
  SelectButton,
  TextField,
  type SelectControl,
} from "../../../components";
import { useShortcut } from "../../../public/react";
import type {
  ScreenCriterion,
  ScreenFieldDefinition,
  ScreenOperator,
} from "../../../api-client/equity-screener";
import { parseCriterion } from "./model";

export function CriterionEditor({
  fields,
  value,
  onSave,
  onCancel,
  focused,
  width,
}: {
  fields: ScreenFieldDefinition[];
  value: ScreenCriterion | null;
  onSave: (criterion: ScreenCriterion) => void;
  onCancel: () => void;
  focused: boolean;
  width: number;
}) {
  const [fieldId, setFieldId] = useState(
    value?.field ??
      (fields.find((row) => row.id === "trailingPE") ??
        fields.find((row) => row.kind === "number") ??
        fields[0]!).id,
  );
  const field = fields.find((row) => row.id === fieldId)!;
  const [operator, setOperator] = useState<ScreenOperator>(
    value?.op ?? field.operators[0]!,
  );
  const [text, setText] = useState(
    value && "value" in value
      ? Array.isArray(value.value)
        ? value.value.join(", ")
        : String(value.value)
      : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState("field");
  const fieldControl = useRef<SelectControl>(null),
    operatorControl = useRef<SelectControl>(null);
  const ring = [
    "field",
    "operator",
    ...(["present", "missing"].includes(operator) ? [] : ["value"]),
    "save",
    "cancel",
  ];
  const save = () => {
    try {
      onSave(parseCriterion(field, operator, text));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Invalid criterion.");
    }
  };
  useShortcut(
    (event) => {
      if (event.name === "tab") {
        event.preventDefault();
        event.stopPropagation();
        setActive((current) => ring[(ring.indexOf(current) + (event.shift ? -1 : 1) + ring.length) % ring.length]!);
      } else if (event.name === "escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      } else if (
        ["enter", "return"].includes(event.name ?? "") &&
        !event.targetEditable
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (active === "field") fieldControl.current?.open();
        else if (active === "operator") operatorControl.current?.open();
        else if (active === "cancel") onCancel();
        else save();
      }
    },
    {
      enabled: focused,
      allowEditable: true,
      phase: "before",
      scope: "equity-screen-criterion",
    },
  );
  return (
    <Box paddingX={1} paddingTop={1} flexDirection="column" gap={1}>
      <SelectButton
        label="Field"
        emphasized={focused && active === "field"}
        value={fieldId}
        options={fields.map((row) => ({ value: row.id, label: row.label }))}
        variant="field"
        width={Math.min(40, width - 4)}
        onFocus={() => setActive("field")}
        controlRef={fieldControl}
        onChange={(id) => {
          setFieldId(id);
          const next = fields.find((row) => row.id === id)!;
          setOperator(next.operators[0]!);
          setError(null);
        }}
      />
      <SelectButton
        label="Operator"
        emphasized={focused && active === "operator"}
        value={operator}
        options={field.operators.map((op) => ({
          value: op,
          label: {
            gte: "At least",
            lte: "At most",
            gt: "Above",
            lt: "Below",
            eq: "Equals",
            between: "Between",
            in: "One of",
            present: "Available",
            missing: "Unavailable",
          }[op],
        }))}
        variant="field"
        width={Math.min(30, width - 4)}
        onChange={setOperator}
        onFocus={() => setActive("operator")}
        controlRef={operatorControl}
      />
      {!["present", "missing"].includes(operator) ? (
        <TextField
          label={`Value${field.unit ? ` (${field.unit})` : ""}`}
          value={text}
          onChange={setText}
          placeholder={
            operator === "between"
              ? "minimum, maximum"
              : operator === "in"
                ? "comma-separated values"
                : "threshold, e.g. 25 or 10B"
          }
          width={Math.min(45, width - 4)}
          focused={focused && active === "value"}
          onMouseDown={() => setActive("value")}
          onSubmit={save}
        />
      ) : null}
      {error ? <Notice tone="negative">{error}</Notice> : null}
      <Box flexDirection="row" gap={1}>
        <Button
          label="Save criterion"
          variant="primary"
          active={focused && active === "save"}
          onPress={save}
        />
        <Button
          label="Cancel"
          variant="secondary"
          active={focused && active === "cancel"}
          onPress={onCancel}
        />
      </Box>
    </Box>
  );
}
