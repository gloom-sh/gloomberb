import type { TeamCollection, TeamCollectionItem, TeamCollectionKind } from "./types";

type CloudApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

export class CloudCollectionsApi {
  constructor(private readonly request: CloudApiRequest) {}

  async listTeamCollections(teamId: string): Promise<TeamCollection[]> {
    const body = await this.request<{ items?: TeamCollection[] }>(`/teams/${encodeURIComponent(teamId)}/collections`);
    return Array.isArray(body?.items) ? body.items : [];
  }

  async getTeamCollection(teamId: string, collectionId: string): Promise<TeamCollection & { items: TeamCollectionItem[] }> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/collections/${encodeURIComponent(collectionId)}`);
  }

  async createTeamCollection(teamId: string, input: { kind: TeamCollectionKind; name: string; currency?: string | null }): Promise<TeamCollection> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/collections`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async putTeamCollectionItem(
    teamId: string,
    collectionId: string,
    item: { symbol: string; exchange?: string | null; quantity?: number | null; note?: string | null },
  ): Promise<TeamCollectionItem> {
    return this.request(`/teams/${encodeURIComponent(teamId)}/collections/${encodeURIComponent(collectionId)}/items`, {
      method: "PUT",
      body: JSON.stringify(item),
    });
  }

  async removeTeamCollectionItem(teamId: string, collectionId: string, symbol: string, exchange = ""): Promise<void> {
    const query = exchange ? `?exchange=${encodeURIComponent(exchange)}` : "";
    await this.request(
      `/teams/${encodeURIComponent(teamId)}/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(symbol)}${query}`,
      { method: "DELETE" },
    );
  }
}
