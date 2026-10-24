import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { resetBoardCoins } from "../../../cli/board-coins";
import { AppPersistence } from "../../../data/app-persistence";
import { createTestCliContext } from "../../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import type { QuoteBatchResult, QuoteSubscriptionTarget } from "../../../types/data-provider";
import { notesCliCommand } from "./cli";
import { NotesFiles } from "./files";

const STAMP = "2026-10-01T12:00:00.000Z";
const BY = { id: "u0", username: "ada", displayName: "Ada" };
const CLOUD_NOTES: Record<string, { id: string; owner: { kind: string; id: string }; kind: string; key: string; title: string | null; content: string }> = {
  user: { id: "n-user", owner: { kind: "user", id: "u0" }, kind: "ticker", key: "NVDA", title: null, content: "Cloud note\n" },
  "team-1": { id: "n-team", owner: { kind: "team", id: "team-1" }, kind: "quick", key: "t1", title: "Desk ideas", content: "Team note\n" },
};

/** Gloom Cloud as the export reads it: a verified session, one team, one note in each place. */
function stubCloud() {
  setCloudApiFetchTransport(async (url) => {
    const { pathname, searchParams } = new URL(url);
    const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (pathname.endsWith("/auth/get-session")) return answer({ user: { ...BY, email: "ada@example.invalid", name: "Ada", emailVerified: true, plan: "pro" } });
    if (pathname.endsWith("/teams")) return answer({ teams: [{ id: "team-1", name: "Desk", slug: "desk", accentColor: "blue", shortName: "DSK", allowMemberInvites: true, channelId: "c1", createdAt: STAMP, role: "owner", memberCount: 1 }] });
    const full = (note: typeof CLOUD_NOTES[string]) => ({ ...note, revision: 1, updatedBy: BY, createdAt: STAMP, updatedAt: STAMP });
    if (pathname.endsWith("/notes")) {
      const note = CLOUD_NOTES[searchParams.get("scope") === "team" ? searchParams.get("teamId")! : "user"];
      return answer({ items: note ? [{ ...full(note), content: undefined, size: note.content.length }] : [] });
    }
    const note = Object.values(CLOUD_NOTES).find((entry) => pathname.endsWith(`/notes/${entry.id}`));
    return note ? answer(full(note)) : new Response("{}", { status: 404 });
  });
}

// A one-word name is checked against the crypto board, which these tests read empty.
beforeEach(() => resetBoardCoins([]));

afterEach(() => {
  apiClient.setSessionToken(null);
  setCloudApiFetchTransport(null);
  resetBoardCoins();
});

test("a signed-in export writes the Cloud notes beside the local ones, with nothing to warn about", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloomberb-notes-cli-"));
  try {
    await new NotesFiles(dir).save("AAPL", "thesis");
    // The services persistence closes when the services do, as the CLI's does.
    const services = new AppPersistence(":memory:");
    services.pluginState.set("gloomberb-cloud", "session", { sessionToken: "fixture-session" }, 1);
    stubCloud();
    const cli = createTestCliContext({ config: { dataDir: dir }, dataDir: dir });
    cli.context.initServices = async () => ({ persistence: services, destroy: () => services.close() }) as never;

    await notesCliCommand.execute(["export", join(dir, "out")], cli.context);

    expect(cli.printed).toHaveLength(1);
    expect(cli.printed[0]!.result).toEqual({ data: { dir: join(dir, "out"), files: 3, sources: ["local", "mine", "Desk"] } });
    expect(readFileSync(join(dir, "out", "mine", "NVDA.md"), "utf-8")).toBe("Cloud note\n");
    expect(readFileSync(join(dir, "out", "Desk", "quick", "Desk_ideas.md"), "utf-8")).toBe("Team note\n");
    expect(readdirSync(join(dir, "out", "local"))).toEqual(["AAPL.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notes set reads its symbol as quote does: a company's name is its listing, and a word no listing trades as saves nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloomberb-notes-cli-"));
  try {
    const dataProvider = createTestDataProvider({
      search: async (query) => /^petrobras$/i.test(query)
        ? [{ providerId: "test", symbol: "PBR", name: "Petroleo Brasileiro S.A. Petrobras ADR", exchange: "NYSE", type: "Common Stock", currency: "USD" }]
        : [],
      getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => ["PETROBRAS", "ZZZQQ"].includes(target.symbol)
        ? { target, quote: null, error: new Error(`Not a ticker: ${target.symbol}.`) }
        : { target, quote: createTestQuote({ symbol: target.symbol, name: "Petroleo Brasileiro S.A. Petrobras ADR", listingExchangeName: "NYSE" }) }),
    });
    const cli = createTestCliContext({ config: { dataDir: dir }, dataDir: dir, dataProvider });

    await notesCliCommand.execute(["set", "Petrobras", "x"], cli.context);
    expect(cli.printed[0]!.result).toMatchObject({ data: { symbol: "PBR" }, warnings: ['Read "Petrobras" as PBR:NYSE (Petroleo Brasileiro S.A. Petrobras ADR).'] });
    expect(readdirSync(dir).filter((file) => file.endsWith(".md"))).toEqual(["PBR.md"]);
    // The name finds the note it wrote, and so does the ticker.
    await notesCliCommand.execute(["show", "Petrobras"], cli.context);
    await notesCliCommand.execute(["show", "PBR"], cli.context);
    expect(cli.printed.slice(1).map((printed) => (printed.result.data as { text: string }).text)).toEqual(["x", "x"]);

    await expect(notesCliCommand.execute(["set", "zzzqq", "y"], cli.context)).rejects.toThrow("Not a ticker: ZZZQQ.");
    expect(readdirSync(dir).filter((file) => file.endsWith(".md"))).toEqual(["PBR.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("show, set and delete pick one file: a note kept under the word comes first, and set keeps the symbol as typed unless it is surely not a ticker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloomberb-notes-cli-"));
  const files = () => readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  try {
    const looked: string[] = [];
    const listed = createTestDataProvider({
      search: async (query) => {
        looked.push(`search ${query}`);
        return /^apple$/i.test(query) ? [{ providerId: "test", symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", type: "Common Stock", currency: "USD" }] : [];
      },
      getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => {
        looked.push(`quote ${target.symbol}`);
        return target.symbol === "APPLE"
          ? { target, quote: null, error: new Error("Not a ticker: APPLE.") }
          : { target, quote: createTestQuote({ symbol: target.symbol, name: "Apple Inc.", listingExchangeName: "NASDAQ" }) };
      }),
    });
    // A note kept under the word before names were read is the one all three pick.
    writeFileSync(join(dir, "APPLE.md"), "old");
    const cli = createTestCliContext({ config: { dataDir: dir }, dataDir: dir, dataProvider: listed });
    await notesCliCommand.execute(["set", "Apple", "new"], cli.context);
    await notesCliCommand.execute(["show", "Apple"], cli.context);
    expect(cli.printed.map((printed) => (printed.result.data as { symbol: string }).symbol)).toEqual(["APPLE", "APPLE"]);
    expect((cli.printed[1]!.result.data as { text: string }).text).toBe("new");
    expect(files()).toEqual(["APPLE.md"]);
    expect(looked).toEqual([]);
    await notesCliCommand.execute(["delete", "Apple"], cli.context);
    expect(files()).toEqual([]);

    // A dry run opens no data source: it names the note under the symbol as typed.
    const dry = createTestCliContext({ config: { dataDir: dir }, dataDir: dir, dataProvider: listed }, { dryRun: true });
    await notesCliCommand.execute(["set", "Apple", "x"], dry.context);
    expect(dry.printed[0]!.result.data).toMatchObject({ symbol: "APPLE", dryRun: true });
    expect(looked).toEqual([]);

    // Offline, or with the data service down, a note is still written, under the symbol as typed.
    const offline = createTestDataProvider({
      search: async () => { throw new Error("fetch failed"); },
      getQuotesBatch: async (targets: QuoteSubscriptionTarget[]): Promise<QuoteBatchResult[]> => targets.map((target) => ({ target, quote: null, error: new Error("fetch failed") })),
    });
    const away = createTestCliContext({ config: { dataDir: dir }, dataDir: dir, dataProvider: offline });
    await notesCliCommand.execute(["set", "AAPL", "a"], away.context);
    await notesCliCommand.execute(["set", "Apple", "b"], away.context);
    expect(files()).toEqual(["AAPL.md", "APPLE.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
