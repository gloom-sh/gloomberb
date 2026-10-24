import { useCallback, useEffect, useState } from "react";

/**
 * What the last action on one row of a list came to, kept for that row
 * (docs/pane-conventions.md, "Row messages"): the row's status cell shows
 * its short state, its detail the full reason. The footer and toasts stay
 * out of it.
 *
 * A note stands until the caller replaces or clears it (the next action on
 * the row), or, given `signature`, until the row's own status moves past what
 * it was when the note first showed: a later state is newer news than the
 * note. A note on a row that is not listed waits for it; whether a note
 * belongs in a toast instead (its row has left the list) is the caller's call.
 */
export interface RowNotes<Row, Note> {
  /** The row's note while it stands, else null. */
  noteFor(row: Row): Note | null;
  /** Sets or clears one row's note, by the row's key. */
  setNote(key: string, note: Note | null): void;
  /** Clears every note: the list now shows other rows (another account, a reload). */
  clearNotes(): void;
}

interface Kept<Note> {
  note: Note;
  /** The row's signature when the note first showed it. */
  baseline?: string;
}

const NO_NOTES: ReadonlyMap<string, never> = new Map<string, never>();

export function useRowNotes<Row, Note>(rows: readonly Row[], options: {
  key: (row: Row) => string;
  /**
   * The parts of a row a real change moves (its state, its message), never a
   * timestamp a poll restamps on every read. Without it a note stands until
   * it is replaced or cleared.
   */
  signature?: (row: Row) => string;
}): RowNotes<Row, Note> {
  const { key, signature } = options;
  const [notes, setNotes] = useState<ReadonlyMap<string, Kept<Note>>>(NO_NOTES);

  const setNote = useCallback((rowKey: string, note: Note | null) => {
    setNotes((current) => {
      if (!note && !current.has(rowKey)) return current;
      const next = new Map(current);
      if (note) next.set(rowKey, { note });
      else next.delete(rowKey);
      return next;
    });
  }, []);
  const clearNotes = useCallback(() => setNotes((current) => (current.size ? NO_NOTES : current)), []);

  // A note takes its row as the list shows it once the note is up, and goes
  // when that row moves on.
  useEffect(() => {
    if (!signature || notes.size === 0) return;
    setNotes((current) => {
      let next: Map<string, Kept<Note>> | null = null;
      for (const [rowKey, kept] of current) {
        const row = rows.find((entry) => key(entry) === rowKey);
        if (!row) continue;
        const now = signature(row);
        if (kept.baseline === undefined) (next ??= new Map(current)).set(rowKey, { ...kept, baseline: now });
        else if (kept.baseline !== now) (next ??= new Map(current)).delete(rowKey);
      }
      return next ?? current;
    });
  }, [key, notes, rows, signature]);

  const noteFor = useCallback((row: Row): Note | null => {
    const kept = notes.get(key(row));
    if (!kept) return null;
    return !signature || kept.baseline === undefined || kept.baseline === signature(row) ? kept.note : null;
  }, [key, notes, signature]);

  return { noteFor, setNote, clearNotes };
}
