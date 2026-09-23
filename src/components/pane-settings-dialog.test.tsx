import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { PluginRegistry } from "../plugins/registry";
import type {
  PaneSettingActionContext,
  PaneSettingActionField,
  PaneSettingField,
  PaneSettingsContext,
} from "../types/plugin";
import { TestDialogProvider, testRender } from "../renderers/opentui/test-utils";
import { useDialog } from "../ui/dialog";
import { PaneSettingsDialogContent } from "./pane-settings-dialog";
import { TuiPaneSettingsDialogBody } from "./pane-settings-dialog/tui";
import { Button } from "./ui";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

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

    testSetup = await testRender(
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
    await testSetup.renderOnce();

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Promise.resolve();
      await Promise.resolve();
      await testSetup!.renderOnce();
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

    testSetup = await testRender(
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
    await testSetup.renderOnce();
    const lines = testSetup.captureCharFrame().split("\n");
    const enabledRow = lines.findIndex((line) => line.includes("AI Account"));
    const disabledRow = lines.findIndex((line) => line.includes("Unavailable Account"));
    expect(enabledRow).toBeGreaterThanOrEqual(0);
    expect(disabledRow).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(4, enabledRow);
      await testSetup!.mockMouse.click(4, disabledRow);
      await testSetup!.renderOnce();
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
    testSetup = await testRender(
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
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).not.toContain("Setting 14");

    await act(async () => {
      testSetup!.mockInput.pressKey("END");
      await Promise.resolve();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    const frame = testSetup.captureCharFrame();
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
    testSetup = await testRender(
      <NestedSettingsHarness
        field={field}
        applyFieldValue={async (_paneId, _field, value) => {
          applied.push(value);
        }}
      />,
      { width: 72, height: 16 },
    );
    await testSetup.renderOnce();
    const openRow = testSetup.captureCharFrame().split("\n")
      .findIndex((line) => line.includes("Open settings"));
    expect(openRow).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(2, openRow);
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("Chart Settings");

    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Promise.resolve();
      await Promise.resolve();
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("1Y");

    await act(async () => {
      testSetup!.mockInput.pressArrow("down");
      await Bun.sleep(10);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup!.mockInput.pressEnter();
      await Promise.resolve();
      await Promise.resolve();
      await testSetup!.renderOnce();
    });

    expect(applied).toEqual(["1Y"]);
  });
});
