import { describe, expect, test } from "bun:test";
import { namesSecret } from "../../../../remote/secrets";
import { REDACTED, redactRelayResult } from "./redact";

const field = (id: string, label: string, fieldId: string, value: string) => ({
  id,
  role: "form-field",
  label,
  actions: ["setValue"],
  metadata: { scope: "form", fieldId, fieldType: "text", value, summary: value },
});

const textField = (id: string, label: string, value: string, placeholder?: string) => ({
  id,
  role: "text-field",
  label,
  actions: ["setValue"],
  metadata: { value, placeholder, type: "text" },
});

describe("fields named for a credential", () => {
  test("are withheld whatever they are typed as, by id, label or placeholder", () => {
    const tree = redactRelayResult([
      field("ui:1", "Key", "apiKey", "sk-live-1234"),
      field("ui:2", "Code", "otp", "551204"),
      textField("ui:3", "Trading PIN", "4821"),
      textField("ui:4", "Wallet", "abandon ability able", "Seed phrase"),
      field("ui:5", "Ticker", "symbol", "AAPL"),
      textField("ui:6", "Pinned symbols", "NVDA, AMD", "Search"),
    ]) as Array<{ label: string; metadata: Record<string, unknown> }>;
    const values = tree.map((node) => [node.label, node.metadata.value, node.metadata.summary ?? null]);
    expect(values).toEqual([
      ["Key", REDACTED, REDACTED],
      ["Code", REDACTED, REDACTED],
      ["Trading PIN", REDACTED, null],
      ["Wallet", REDACTED, null],
      ["Ticker", "AAPL", "AAPL"],
      ["Pinned symbols", "NVDA, AMD", null],
    ]);
  });

  test("are withheld from the open form, read from its node or from app://form", () => {
    const fields = [
      { id: "bearer", label: "Access", type: "text", required: true, visible: true, value: "eyJhbGciOi" },
      { id: "account", label: "Account", type: "text", required: true, visible: true, value: "U1234567" },
    ];
    const form = { kind: "form", title: "Connect", fields, error: null, pending: false, submitLabel: "Connect" };
    const read = redactRelayResult({
      tree: [{ id: "ui:9", role: "form", label: "Connect", actions: ["submit"], metadata: { scope: "form", ...form } }],
      resource: { open: true, nodeId: "ui:9", actions: ["submit"], ...form },
    });
    for (const shown of [read.tree[0]!.metadata.fields, read.resource.fields]) {
      expect(shown.map((entry: { value: unknown }) => entry.value)).toEqual([REDACTED, "U1234567"]);
    }
  });

  test("a bare input or textarea is a field too, named by its label or placeholder", () => {
    const tree = redactRelayResult([
      { id: "ui:1", role: "input", label: "API key", actions: ["setValue"], metadata: { value: "sk-live-1234", placeholder: "API key" } },
      { id: "ui:2", role: "textarea", label: "Notes", actions: ["setValue"], metadata: { value: "call back", placeholder: "Seed phrase" } },
      { id: "ui:3", role: "input", label: "Search", actions: ["setValue"], metadata: { value: "NVDA", placeholder: "Search" } },
    ]) as Array<{ metadata: Record<string, unknown> }>;
    expect(tree.map((node) => node.metadata.value)).toEqual([REDACTED, REDACTED, "NVDA"]);
  });

  test("what was typed into one is withheld from every other node of the same answer", () => {
    const read = redactRelayResult({
      tree: [
        field("ui:1", "Key", "apiKey", "sk-live-4f9Qx2"),
        field("ui:2", "Code", "otp", "5512"),
        // Controls under the fields that list the text again without their names.
        { id: "ui:3", role: "input", label: "Paste it here", actions: ["setValue"], metadata: { value: "sk-live-4f9Qx2" } },
        textField("ui:4", "Code", "5512"),
        { id: "ui:5", role: "text", label: "Copied sk-live-4f9Qx2 to the field" },
        // Short text is withheld only as a field's whole value, not inside other text.
        { id: "ui:6", role: "text", label: "Quantity 5512" },
      ],
    });
    expect(read.tree.map((node: { label: string; metadata?: Record<string, unknown> }) => node.metadata?.value ?? node.label)).toEqual([
      REDACTED,
      REDACTED,
      REDACTED,
      REDACTED,
      `Copied ${REDACTED} to the field`,
      "Quantity 5512",
    ]);
  });

  test("a list of fields that is not a form keeps its values", () => {
    const columns = { fields: [{ id: "token", label: "Token", value: "ETH" }] };
    expect(redactRelayResult(columns)).toEqual(columns);
  });
});

describe("credential names", () => {
  test("short words count only on their own, as a key or a field's name", () => {
    expect(redactRelayResult({
      pin: "1234",
      otp_code: "551204",
      jwt: "eyJhbGciOi",
      bearer: "abc123",
      mnemonic: "abandon ability able",
      "seed phrase": "abandon ability able",
      pinned: ["AAPL"],
      pinTicker: "AAPL",
      spinner: "dots",
      seedSymbols: ["SPY"],
      footprint: "large",
    })).toEqual({
      pin: REDACTED,
      otp_code: REDACTED,
      jwt: REDACTED,
      bearer: REDACTED,
      mnemonic: REDACTED,
      "seed phrase": REDACTED,
      pinned: ["AAPL"],
      pinTicker: "AAPL",
      spinner: "dots",
      seedSymbols: ["SPY"],
      footprint: "large",
    });
    expect(["PIN", "Enter your OTP", "JWT", "Bearer token", "Recovery mnemonic", "wallet-seed"].every((name) => namesSecret(name))).toBe(true);
    expect(["pinned", "Spinner", "pinTicker", "seedSymbols", "Seeded", "otpEnabled"].some((name) => namesSecret(name))).toBe(false);
  });
});
