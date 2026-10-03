import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { openCloudUpgradeUrl, useCloudUpgradeAction } from "./cloud-upgrade";

const tui = createOpenTuiTestHarness();

function Prompt({ placement }: { placement: string }) {
  useCloudUpgradeAction(placement);
  return null;
}

test("the UPGRADE command still opens checkout after the newest prompt closes", async () => {
  let showFooter!: (shown: boolean) => void;
  function Prompts() {
    const [footer, setFooter] = useState(true);
    showFooter = setFooter;
    return (
      <>
        <Prompt placement="status-widget" />
        {footer ? <Prompt placement="news-footer" /> : null}
      </>
    );
  }
  await tui.render(<Prompts />);
  await act(async () => {
    showFooter(false);
    await tui.setup().renderOnce();
  });
  // Signed out, the remaining opener sends the person to the Cloud page; what
  // matters is that the command did not fall back to the account pane.
  expect(openCloudUpgradeUrl("command")).toBe(true);
  await tui.destroy();
  expect(openCloudUpgradeUrl("command")).toBe(false);
});
