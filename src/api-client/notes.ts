import { ApiRequestError, RevisionConflictError } from "./errors";
import { putWithRevision, type CloudApiRequest } from "./request";
import type { CloudNote, CloudNoteScope, CloudNoteSummary, NoteKind } from "./types";

/** A save refused because the note changed since it was loaded. */
export class NoteConflictError extends RevisionConflictError<CloudNote> {
  override name = "NoteConflictError";
}

/** The owner query shared by note and thesis lists. */
export function scopeQuery(scope: { scope: string; teamId?: string }): string {
  const params = new URLSearchParams({ scope: scope.scope });
  if (scope.teamId) params.set("teamId", scope.teamId);
  return params.toString();
}

export class CloudNotesApi {
  constructor(private readonly request: CloudApiRequest) {}

  async listNotes(scope: CloudNoteScope): Promise<CloudNoteSummary[]> {
    const body = await this.request<{ items: CloudNoteSummary[] }>(`/notes?${scopeQuery(scope)}`);
    return body.items;
  }

  async getNote(id: string): Promise<CloudNote | null> {
    try {
      return await this.request<CloudNote>(`/notes/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Upserts by (owner, kind, key). `expectedRevision` becomes If-Match; a 412
   * throws NoteConflictError carrying the note the server holds now.
   */
  async putNote(input: {
    scope: CloudNoteScope;
    kind: NoteKind;
    key: string;
    title?: string | null;
    content: string;
    expectedRevision?: number;
  }): Promise<CloudNote> {
    return putWithRevision<CloudNote, CloudNote>(this.request, "/notes", {
      scope: input.scope.scope,
      ...(input.scope.teamId ? { teamId: input.scope.teamId } : {}),
      kind: input.kind,
      key: input.key,
      ...(input.title !== undefined ? { title: input.title } : {}),
      content: input.content,
    }, {
      expected: input.expectedRevision,
      // The 412 body carries the current note, but the transport keeps only
      // the message. One extra read gets the editor's name and content.
      loadCurrent: () => this.findNote(input.scope, input.kind, input.key),
      conflict: NoteConflictError,
    });
  }

  async deleteNote(id: string): Promise<void> {
    try {
      await this.request<unknown>(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return;
      throw error;
    }
  }

  private async findNote(scope: CloudNoteScope, kind: NoteKind, key: string): Promise<CloudNote | null> {
    const summary = (await this.listNotes(scope)).find((entry) => entry.kind === kind && entry.key === key);
    return summary ? this.getNote(summary.id) : null;
  }
}
