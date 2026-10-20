import { expect, mock, spyOn, test } from "bun:test";
import type { NewsCapability } from "../../../../capabilities";
import { NewsService } from "../../../../news/aggregator";
import { MemoryPluginPersistence } from "../../../../test-support/plugin-persistence";
import type { CommandDef, GloomPluginContext, PluginConfigState } from "../../../../types/plugin";
import { DEFAULT_FEEDS } from "./default-feeds";
import { newsWireModule } from "./index";

for (const key of ["feeds", "disabledDefaultFeedIds"]) {
  test(`startup preserves unreadable ${key}, exposes failure, and recovers after repair`, async () => {
    const original = {
      feeds: "[]",
      disabledDefaultFeedIds: JSON.stringify(DEFAULT_FEEDS.map((feed) => feed.id)),
      [key]: '["broken"',
    };
    const stored = new Map<string, unknown>(Object.entries(original));
    const configState: PluginConfigState = {
      get: <T,>(name: string) => (stored.get(name) as T | undefined) ?? null,
      set: mock(async (name: string, value: unknown) => { stored.set(name, value); }),
      delete: async (name) => { stored.delete(name); },
      keys: () => [...stored.keys()],
    };
    const service = new NewsService();
    let registered: NewsCapability | undefined;
    const commands: CommandDef[] = [];
    const notify = mock(() => {});
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Unexpected network request.");
    });
    try {
      await newsWireModule.setup!({
        configState,
        persistence: new MemoryPluginPersistence(),
        registerCapability: (source: NewsCapability) => {
          registered = source;
          service.register(source);
        },
        registerCommand: (command: CommandDef) => commands.push(command),
        registerCommandBarSearchProvider: () => {},
        on: () => () => {},
        notify,
      } as unknown as GloomPluginContext);
      // Exercise the real service, including the synchronous cache seeding path.
      const failed = await service.load({ feed: "latest" });
      expect(failed.error).toBe("News feed settings could not be read. Saved settings were kept.");
      expect(failed.articles).toEqual([]);
      await expect(registered!.provider.fetchNews({ feed: "latest" }))
        .rejects.toThrow("News feed settings could not be read");
      expect(configState.set).not.toHaveBeenCalled();
      expect(Object.fromEntries(stored)).toEqual(original);
      await expect(commands.find((command) => command.id === "add-news-feed")!.execute({
        name: "Added", url: "https://example.test/rss",
      })).rejects.toThrow("News feed settings could not be read");
      expect(notify).not.toHaveBeenCalled();
      expect(configState.set).not.toHaveBeenCalled();

      // A repair (or an explicit reset) is picked up by the next refresh.
      stored.set("feeds", []);
      stored.set("disabledDefaultFeedIds", DEFAULT_FEEDS.map((feed) => feed.id));
      const recovered = await service.load({ feed: "latest" });
      expect(recovered.error).toBeNull();
      expect(recovered.articles).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      newsWireModule.dispose!();
      service.stop();
      fetch.mockRestore();
    }
  });
}
