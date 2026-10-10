import { expect, test } from "bun:test";
import { cleanProviderReason, createProviderMiss, noProviderError, providerMissReason } from "./provider-errors";

test("a service reason is trimmed to one clean line of at most 200 characters", () => {
  expect(cleanProviderReason("  Spot gold is not quoted; GC=F is the front-month future.  "))
    .toBe("Spot gold is not quoted; GC=F is the front-month future.");
  expect(cleanProviderReason("First line.\r\n\n  Second\tline.")).toBe("First line. Second line.");
  // Escape sequences and reordering controls never reach a terminal.
  expect(cleanProviderReason("\u001b[31mNot quoted\u001b[0m\u0007 \u202eelbat\u202c\u0000")).toBe("Not quoted elbat");
  for (const missing of [undefined, null, 42, {}, "", "  \n\t ", "\u0000\u001b"]) expect(cleanProviderReason(missing)).toBeUndefined();

  const capped = cleanProviderReason(`${"word ".repeat(80)}tail`)!;
  expect(Array.from(capped)).toHaveLength(200);
  expect(capped.endsWith("…")).toBe(true);
  // A cap never splits a surrogate pair.
  expect(cleanProviderReason("😀".repeat(300))!.replace("…", "")).toBe("😀".repeat(199));
});

test("the final no-provider error carries a reason only when a provider gave one", () => {
  const withReason = noProviderError("No quote provider available for XAU/USD", { reason: "Spot gold is not quoted." });
  expect(withReason.message).toBe("Spot gold is not quoted.");
  expect(providerMissReason(withReason)).toBe("Spot gold is not quoted.");

  for (const note of [undefined, {}]) {
    const generic = noProviderError("No quote provider available for XAU/USD", note);
    expect(generic.message).toBe("No quote provider available for XAU/USD");
    expect(providerMissReason(generic)).toBeUndefined();
  }
  expect(providerMissReason(createProviderMiss("NOT_FOUND"))).toBeUndefined();
  expect(providerMissReason(new Error("Spot gold is not quoted."))).toBeUndefined();
});
