import { describe, expect, test } from "bun:test";
import type { AskGloomPaneAttachment } from "../../../../ask-gloom/pane-request";
import { attachedPaneContext, attachPane } from "./pane-attachment";

/** Invented figures: never anyone's holdings. */
function pane(patch: Partial<AskGloomPaneAttachment> = {}): AskGloomPaneAttachment {
  return {
    paneId: "portfolio-list:main",
    paneType: "portfolio-list",
    title: "Example Portfolio",
    code: "PF",
    symbol: null,
    args: { tab: "Positions" },
    visibleText: "ACME  120 shares  12,400.00\nGLOBEX  40 shares  3,020.50",
    personal: true,
    ...patch,
  };
}

function shown(context: ReturnType<typeof attachedPaneContext>): string | undefined {
  return (context.layout as { attachedPane: { shows?: string } }).attachedPane.shows;
}

describe("attachedPaneContext", () => {
  test("a pane with the user's holdings sends nothing it shows until they say yes", () => {
    const pending = attachPane(pane());
    expect(pending.consent).toBe("pending");
    expect(JSON.stringify(attachedPaneContext(pending))).not.toContain("ACME");
    expect(JSON.stringify(attachedPaneContext({ ...pending, consent: "declined" }))).not.toContain("ACME");
    // Arguments can name the account too, so they wait with the contents.
    expect(JSON.stringify(attachedPaneContext({ ...pending, consent: "declined" }))).not.toContain("Positions");

    const granted = attachedPaneContext({ ...pending, consent: "granted" });
    expect(shown(granted)).toContain("ACME  120 shares");
    expect(granted.query).toBe("PF");
  });

  test("a full pane is cut to what the platform keeps, and the fields stay inside the route's bounds", () => {
    const rows = Array.from({ length: 200 }, (_, index) => `Row ${index}  ${(index * 1.5).toFixed(2)}`);
    const context = attachedPaneContext(attachPane(pane({
      paneId: `chart:${"x".repeat(120)}`,
      symbol: "NOT-A-REAL-SYMBOL-THAT-IS-FAR-TOO-LONG",
      title: "G ACME",
      code: "G",
      personal: false,
      visibleText: rows.join("\n"),
    })));
    expect(JSON.stringify(context.layout).length).toBeLessThanOrEqual(2_000);
    expect(shown(context)?.endsWith("…")).toBe(true);
    expect(shown(context)).toStartWith("Row 0  0.00\nRow 1  1.50");
    expect(context.paneId!.length).toBeLessThanOrEqual(64);
    // Too long for the route: left out rather than failing the question.
    expect(context.symbol).toBeUndefined();
  });
});
