import { ApiRequestError } from "./errors";
import type {
  CloudNoteScope,
  CloudThesis,
  ThesisDocument,
  ThesisDraft,
  ThesisPatch,
  ThesisSignal,
  ThesisStatus,
} from "./types";

type CloudApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>;

/** A save refused because the thesis changed since it was loaded. */
export class ThesisConflictError extends Error {
  constructor(
    message: string,
    public readonly current: CloudThesis | null,
  ) {
    super(message);
    this.name = "ThesisConflictError";
  }
}

/** A revision the server refused because a fired kill condition was moved without a note. */
export class ThesisGoalpostError extends Error {
  constructor(
    message: string,
    public readonly movedGoalposts: string[],
  ) {
    super(message);
    this.name = "ThesisGoalpostError";
  }
}

export type ThesisListScope = CloudNoteScope | { scope: "all" };

function scopeQuery(scope: ThesisListScope): string {
  const params = new URLSearchParams({ scope: scope.scope });
  if ("teamId" in scope && scope.teamId) params.set("teamId", scope.teamId);
  return params.toString();
}

function encode(id: string): string {
  return encodeURIComponent(id);
}

export class CloudThesesApi {
  constructor(private readonly request: CloudApiRequest) {}

  async listTheses(scope: ThesisListScope): Promise<CloudThesis[]> {
    const body = await this.request<{ items: CloudThesis[] }>(`/theses?${scopeQuery(scope)}`);
    return body.items;
  }

  async getThesis(id: string): Promise<(CloudThesis & { signals: ThesisSignal[] }) | null> {
    try {
      return await this.request<CloudThesis & { signals: ThesisSignal[] }>(`/theses/${encode(id)}`);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null;
      throw error;
    }
  }

  createThesis(input: {
    scope: CloudNoteScope;
    title: string;
    status?: ThesisStatus;
    conviction?: number;
    horizon?: string | null;
    reviewEveryDays?: number;
    document: ThesisDocument;
  }): Promise<CloudThesis> {
    return this.request<CloudThesis>("/theses", {
      method: "POST",
      body: JSON.stringify({
        scope: input.scope.scope,
        ...(input.scope.teamId ? { teamId: input.scope.teamId } : {}),
        title: input.title,
        ...(input.status ? { status: input.status } : {}),
        ...(input.conviction !== undefined ? { conviction: input.conviction } : {}),
        ...(input.horizon !== undefined ? { horizon: input.horizon } : {}),
        ...(input.reviewEveryDays !== undefined ? { reviewEveryDays: input.reviewEveryDays } : {}),
        document: input.document,
      }),
    });
  }

  /**
   * Applies a patch as one revision. `expectedRevision` becomes If-Match; a
   * 412 throws ThesisConflictError, a refused goalpost move throws
   * ThesisGoalpostError so the caller can ask for the note.
   */
  async updateThesis(id: string, patch: ThesisPatch, expectedRevision?: number): Promise<CloudThesis> {
    try {
      return await this.request<CloudThesis>(`/theses/${encode(id)}`, {
        method: "PUT",
        headers: expectedRevision ? { "if-match": String(expectedRevision) } : {},
        body: JSON.stringify(patch),
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 412) {
        const current = await this.getThesis(id).catch(() => null);
        throw new ThesisConflictError(error.message, current);
      }
      if (error instanceof ApiRequestError && error.status === 400 && /kill condition/i.test(error.message)) {
        throw new ThesisGoalpostError(error.message, []);
      }
      throw error;
    }
  }

  async deleteThesis(id: string): Promise<void> {
    try {
      await this.request<unknown>(`/theses/${encode(id)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return;
      throw error;
    }
  }

  createThesisSignal(id: string, input: {
    targetKind: "pillar" | "kill" | "catalyst" | "thesis";
    targetId: string | null;
    verdict: "supports" | "challenges" | "breaks";
    reason: string;
  }): Promise<ThesisSignal> {
    return this.request<ThesisSignal>(`/theses/${encode(id)}/signals`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  resolveThesisSignal(id: string, signalId: string, input: {
    status: "accepted" | "dismissed" | "snoozed";
    note?: string | null;
    snoozeDays?: number;
    apply?: boolean;
  }): Promise<{ signal: ThesisSignal; thesis: CloudThesis }> {
    return this.request<{ signal: ThesisSignal; thesis: CloudThesis }>(
      `/theses/${encode(id)}/signals/${encode(signalId)}/resolve`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  /**
   * Pro: queues the audit of every claim against fundamentals and news. It
   * runs in the background; the result arrives as a `thesis.signals` frame.
   */
  reviewThesis(id: string): Promise<{ queued: boolean }> {
    return this.request<{ queued: boolean }>(`/theses/${encode(id)}/review`, { method: "POST" });
  }

  /** Pro: a structured draft from a sentence of reasoning plus company data. */
  async draftThesis(input: {
    instruments: Array<{ symbol: string; exchange?: string; side?: "long" | "short" }>;
    reasoning: string;
    note?: string | null;
  }): Promise<ThesisDraft> {
    const body = await this.request<{ draft: ThesisDraft }>("/theses/draft", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return body.draft;
  }
}
