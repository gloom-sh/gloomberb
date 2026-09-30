import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { PluginRegistry } from "../plugins/registry";
import type {
  PaneSettingActionContext,
  PaneSettingActionField,
  PaneSettingField,
  PaneSettingsContext,
} from "../types/plugin";
import { createOpenTuiTestHarness, TestDialogProvider } from "../renderers/opentui/test-utils";
import { useDialog } from "../ui/dialog";
import { PaneSettingsDialogContent } from "./pane-settings-dialog";
import { TuiPaneSettingsDialogBody } from "./pane-settings-dialog/tui";
import { Button } from "./ui";

const tui = createOpenTuiTestHarness();

const context = {
  paneId: "test-pane:main",
  settings: {},
} as PaneSettingsContext;

function makeField(overrides: Partial<PaneSettingActionField> = {}): PaneSettingActionField {
  return {
    key: "connection",
    label: "AI Account",
    description: "Connect an account used by this pane.",
    type: "action",
    actionId: "ai.connect",
    actionLabel: "Connect",
    action: () => {},
    ...overrides,
  };
}

function makeRegistry(
  field: PaneSettingActionField,
  options: { openCommandBar?: (query?: string) => void } = {},
): PluginRegistry {
  return {
    resolvePaneSettings: () => ({
      paneId: context.paneId,
      pane: { title: "AI", paneId: "test-pane" },
      paneDef: { name: "AI" },
      settingsDef: { title: "AI Settings", fields: [field] },
      context,
    }),
    openCommandBar: options.openCommandBar ?? (() => {}),
    notify: () => {},
  } as unknown as PluginRegistry;
}

function NestedSettingsHarness({
  field,
  applyFieldValue,
}: {
  field: PaneSettingField;
  applyFieldValue: (paneId: string, field: PaneSettingField, value: unknown) => Promise<void>;
}) {
  const dialog = useDialog();
  const registry = {
    resolvePaneSettings: () => ({
      paneId: context.paneId,
      pane: { title: "Chart", paneId: "chart-composer" },
      paneDef: { name: "Chart" },
      settingsDef: { title: "Chart Settings", fields: [field] },
      context,
    }),
    openCommandBar: () => {},
    notify: () => {},
  } as unknown as PluginRegistry;
  return (
    <Button
      label="Open settings"
      onPress={() => {
        void dialog.alert({
          content: (ctx: { dismiss: () => void }) => (
            <PaneSettingsDialogContent
              {...ctx}
              paneId={context.paneId}
              pluginRegistry={registry}
              applyFieldValue={applyFieldValue}
            />
          ),
        });
      }}
    />
  );
}

describe("pane settings action rows", () => {
  test("activates an action row from the keyboard", async () => {
    const calls: PaneSettingActionContext[] = [];
    const opened: Array<string | undefined> = [];
    let dismissed = false;
    const field = makeField({
      action: (nextContext) => {
        calls.push(nextContext);
        nextContext.openCommandBar("AI LOGIN");
      },
    });

    await tui.render(
      <TestDialogProvider>
        <PaneSettingsDialogContent
          dismiss={() => { dismissed = true; }}
          paneId={context.paneId}
          pluginRegistry={makeRegistry(field, {
            openCommandBar: (query) => { opened.push(query); },
          })}
          applyFieldValue={async () => { throw new Error("Action rows must not apply values."); }}
        />
      </TestDialogProvider>,
      { width: 72, height: 14 },
    );
    await tui.setup().renderOnce();

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Promise.resolve();
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    expect(calls[0]).toMatchObject({
      paneId: context.paneId,
      settings: context.settings,
      surface: "pane-dialog",
    });
    expect(typeof calls[0]?.openCommandBar).toBe("function");
    expect(dismissed).toBe(true);
    expect(opened).toEqual(["AI LOGIN"]);
  });

  test("activates enabled TUI action rows by mouse and ignores disabled rows", async () => {
    const activated: string[] = [];
    const enabled = makeField();
    const disabled = makeField({
      key: "unavailable",
      label: "Unavailable Account",
      actionId: "ai.unavailable",
      actionLabel: "Unavailable",
      disabled: true,
    });

    await tui.render(
      <TuiPaneSettingsDialogBody
        title="AI Settings"
        fields={[enabled, disabled]}
        selectedIndex={0}
        settings={{}}
        onSelect={() => {}}
        onActivate={(field) => { if (field) activated.push(field.key); }}
      />,
      { width: 72, height: 14 },
    );
    await tui.setup().renderOnce();
    const lines = tui.frame().split("\n");
    const enabledRow = lines.findIndex((line) => line.includes("AI Account"));
    const disabledRow = lines.findIndex((line) => line.includes("Unavailable Account"));
    expect(enabledRow).toBeGreaterThanOrEqual(0);
    expect(disabledRow).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(4, enabledRow);
      await tui.setup().mockMouse.click(4, disabledRow);
      await tui.setup().renderOnce();
    });

    expect(activated).toEqual([enabled.key]);
  });

  test("scrolls a long TUI settings list to the cursor and steps over disabled rows", async () => {
    const toggles: PaneSettingField[] = Array.from({ length: 14 }, (_, index) => ({
      key: `field-${index + 1}`,
      label: `Setting ${index + 1}`,
      description: `About setting ${index + 1}`,
      type: "toggle",
    }));
    const disabled = makeField({ key: "unavailable", label: "Unavailable Account", disabled: true });
    const registry = {
      ...makeRegistry(makeField()),
      resolvePaneSettings: () => ({
        paneId: context.paneId,
        pane: { title: "AI", paneId: "test-pane" },
        paneDef: { name: "AI" },
        settingsDef: { title: "AI Settings", fields: [...toggles, disabled] },
        context,
      }),
    } as unknown as PluginRegistry;
    await tui.render(
      <TestDialogProvider>
        <PaneSettingsDialogContent
          dismiss={() => {}}
          paneId={context.paneId}
          pluginRegistry={registry}
          applyFieldValue={async () => {}}
        />
      </TestDialogProvider>,
      { width: 72, height: 18 },
    );
    await tui.setup().renderOnce();
    expect(tui.frame()).not.toContain("Setting 14");

    await act(async () => {
      tui.setup().mockInput.pressKey("END");
      await Promise.resolve();
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    const frame = tui.frame();
    expect(frame).toContain("▸ Setting 14");
    expect(frame).toContain("About setting 14");
  });

  test("routes keyboard input to a nested select instead of the parent settings list", async () => {
    const applied: unknown[] = [];
    const field: PaneSettingField = {
      key: "range",
      label: "Range",
      type: "select",
      options: [
        { value: "1M", label: "1M" },
        { value: "1Y", label: "1Y" },
      ],
    };
    await tui.render(
      <NestedSettingsHarness
        field={field}
        applyFieldValue={async (_paneId, _field, value) => {
          applied.push(value);
        }}
      />,
      { width: 72, height: 16 },
    );
    await tui.setup().renderOnce();
    const openRow = tui.frame().split("\n")
      .findIndex((line) => line.includes("Open settings"));
    expect(openRow).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(2, openRow);
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("Chart Settings");

    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Promise.resolve();
      await Promise.resolve();
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("1Y");

    await act(async () => {
      tui.setup().mockInput.pressArrow("down");
      await Bun.sleep(10);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await Promise.resolve();
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    expect(applied).toEqual(["1Y"]);
  });
});
