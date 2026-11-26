import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppPersistence } from "../../data/app-persistence";
import { docsModule } from "../../plugins/builtin/docs";
import { createTestCliContext } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import * as paneShot from "../desktop-pane-shot";
import { CLI_EXIT_CODES } from "../exit-codes";
import { runPaneScreenshot } from ".";
import { PANE_SWEEP_EVIDENCE_PATH } from "./screenshot-types";

test("shot publishes the image only when the assessed result can pass the requested strictness", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gloom-strict-shot-"));
  const outputPath = join(folder, "docs.png");
  const exitCode = process.exitCode;
  const evidencePath = process.env[PANE_SWEEP_EVIDENCE_PATH];
  const base = {
    visibleText: "Docs", rows: [], truncated: false, truncationReasons: [], loadingStateDetected: false,
    errorStateDetected: false, errorStateMarkers: [], emptyStateDetected: false, emptyStateMarkers: [],
    visibleKeyValues: [], semanticUi: [], contentFigures: 24, image: new Uint8Array([137, 80, 78, 71]),
  } satisfies paneShot.DesktopPaneShotRenderResult & { image: Uint8Array };
  const render = spyOn(paneShot, "renderDesktopPaneScreenshot");
  try {
    for (const [state, strict, saves, sweep] of [
      [{ errorStateDetected: true, errorStateMarkers: ["The request failed."] }, true, false],
      [{ loadingStateDetected: true }, true, false],
      [{ emptyStateDetected: true }, true, false],
      [{ accessGate: "sign-in" }, true, false],
      [{ errorStateDetected: true }, false, true],
      [{}, true, true],
      [{ errorStateDetected: true }, true, true, "matched"],
      [{ emptyStateDetected: true }, true, true, "matched"],
      [{ accessGate: "pro" }, true, true, "matched"],
      [{ errorStateDetected: true }, true, false, "other"],
    ] as const) {
      delete process.env[PANE_SWEEP_EVIDENCE_PATH];
      if (sweep) process.env[PANE_SWEEP_EVIDENCE_PATH] = sweep === "matched" ? outputPath : join(folder, "elsewhere.png");
      const { context, printed } = createTestCliContext({
        config: createDefaultConfig(folder), dataProvider: createTestDataProvider(), persistence: new AppPersistence(":memory:"),
      }, { format: "json" });
      (context as { plugins?: unknown }).plugins = [docsModule];
      render.mockResolvedValue({ ...base, ...state });
      process.exitCode = 0;
      await runPaneScreenshot(["DOCS", "--output", outputPath, ...(strict ? ["--strict"] : [])], context);
      expect(await Bun.file(outputPath).exists()).toBe(saves);
      expect(printed[0]?.result.data).toMatchObject({ saved: saves });
      expect(process.exitCode).toBe(strict && Object.keys(state).length ? CLI_EXIT_CODES.unusableShot : 0);
      if (saves) await rm(outputPath);
    }
  } finally {
    if (evidencePath === undefined) delete process.env[PANE_SWEEP_EVIDENCE_PATH];
    else process.env[PANE_SWEEP_EVIDENCE_PATH] = evidencePath;
    process.exitCode = exitCode ?? 0;
    render.mockRestore();
    await rm(folder, { recursive: true, force: true });
  }
});
