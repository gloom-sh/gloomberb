import { PluginStateStore } from "./plugin-state-store";
import { ResourceStore } from "./resource-store";
import { SessionStore } from "./session-store";
import { SqliteDatabase, type SqliteDatabaseOptions } from "./sqlite/database";
import { TickerStore } from "./ticker-store";

export class AppPersistence {
  readonly database: SqliteDatabase;
  readonly tickers: TickerStore;
  readonly resources: ResourceStore;
  readonly pluginState: PluginStateStore;
  readonly sessions: SessionStore;

  constructor(dbPath: string, options: SqliteDatabaseOptions = {}) {
    this.database = new SqliteDatabase(dbPath, options);
    const { connection, access } = this.database;
    this.tickers = new TickerStore(connection, access);
    this.resources = new ResourceStore(connection, access);
    this.pluginState = new PluginStateStore(connection, access);
    this.sessions = new SessionStore(connection, access);
  }

  close(): void {
    this.resources.close();
    this.database.close();
  }
}
