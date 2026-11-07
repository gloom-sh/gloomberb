/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { WebInputHostProvider } from "../renderers/dom/input-host";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import { Button, TextField } from "../components/ui";
import {
  OnboardingActions,
  OnboardingButton,
  OnboardingHeader,
  OnboardingModal,
  OnboardingTitle,
} from "../components/onboarding/onboarding-frame";
import { formSnapshot } from "./form";
import { findMatchingUiNode } from "./matching";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "./semantic-tree";

const { render } = createDomTestHarness();

test("the setup card reads as the open form: step, title, fields (no secrets) and buttons, with submit, cancel and matching acting on it", async () => {
  const registry = createRemoteUiRegistry();
  const pressed: string[] = [];
  await render(
    <WebInputHostProvider>
      <RemoteUiRegistryProvider registry={registry}>
        <Button label="Back" onPress={() => pressed.push("pane back")} />
        <OnboardingModal>
          <OnboardingHeader active="cloud" onDismiss={() => pressed.push("skip setup")} />
          <OnboardingTitle title="Connect Gloom Cloud" description="Free account." />
          <TextField label="Email" value="ada@example.com" onChange={() => {}} />
          <TextField label="Password" type="password" value="hunter22" onChange={() => {}} />
          <TextField placeholder="Enter api key" value="k-live-123" onChange={() => {}} />
          <OnboardingActions>
            <OnboardingButton label="Back" variant="ghost" onPress={() => pressed.push("back")} />
            <OnboardingButton label="Continue" variant="primary" shortcut="Enter" onPress={() => pressed.push("continue")} />
          </OnboardingActions>
        </OnboardingModal>
      </RemoteUiRegistryProvider>
    </WebInputHostProvider>,
  );

  const nodes = registry.snapshot();
  const form = formSnapshot(nodes, false) as Record<string, unknown> & { nodeId: string };
  expect(form).toMatchObject({
    open: true,
    kind: "setup",
    // The desktop card names its step in the progress header only.
    step: "Gloom Cloud",
    title: "Connect Gloom Cloud",
    description: "Free account.",
    actions: ["cancel", "submit"],
    submitLabel: "Continue",
  });
  expect((form.fields as Array<Record<string, unknown>>).map(({ label, value, type, filled }) => ({ label, value, type, filled })))
    .toEqual([
      { label: "Email", value: "ada@example.com", type: undefined, filled: undefined },
      // A password says it is filled, never what it is, and so does a key typed in the clear.
      { label: "Password", value: undefined, type: "password", filled: true },
      { label: "Enter api key", value: undefined, type: undefined, filled: true },
    ]);
  expect(JSON.stringify(form)).not.toContain("k-live-123");
  expect((form.buttons as Array<{ label: string }>).map((button) => button.label)).toEqual(["Skip setup", "Back", "Continue"]);

  // The card covers the panes, so its own Back is the one a match presses.
  const back = findMatchingUiNode(nodes, { role: "button", label: "Back" });
  expect(back?.metadata?.scope).toBe("form");
  await act(async () => {
    await registry.invoke(back!.id, "press");
    await registry.invoke(form.nodeId, "submit");
    await registry.invoke(form.nodeId, "cancel");
  });
  expect(pressed).toEqual(["back", "continue", "skip setup"]);
});
