// Cloud notes

type NoteOwnerKind = "user" | "team";
export type NoteKind = "ticker" | "quick";

interface CloudNoteOwner {
  kind: NoteOwnerKind;
  id: string;
}

export interface CloudNoteSummary {
  id: string;
  owner: CloudNoteOwner;
  kind: NoteKind;
  key: string;
  title: string | null;
  revision: number;
  /** Who wrote the note; null when unknown. Older servers leave it out. */
  createdBy?: string | null;
  updatedBy: { id: string; username: string | null; displayName: string };
  createdAt: string;
  updatedAt: string;
  size: number;
}

export interface CloudNote extends Omit<CloudNoteSummary, "size"> {
  content: string;
}

export interface CloudNoteScope {
  scope: NoteOwnerKind;
  teamId?: string;
}

// Theses

export type ThesisStatus = "watching" | "active" | "closed";
export type ThesisHealth = "unverified" | "intact" | "weakening" | "broken";
export type ThesisPillarStatus = ThesisHealth;

interface ThesisInstrument {
  symbol: string;
  exchange?: string;
  side: "long" | "short";
  role: "core" | "hedge";
}

interface ThesisMetricBound {
  key: string;
  op: ">=" | "<=";
  value: number;
  unit?: string;
}

export interface ThesisPillar {
  id: string;
  text: string;
  kind: "qualitative" | "metric";
  metric?: ThesisMetricBound;
  /** Symbol the claim is about; absent means the thesis as a whole. */
  scope?: string;
  status: ThesisPillarStatus;
  note?: string;
}

export interface ThesisKillCondition {
  id: string;
  text: string;
  triggered: boolean;
  note?: string;
}

export interface ThesisCatalyst {
  id: string;
  text: string;
  date?: string;
  status: "pending" | "hit" | "missed";
}

export interface ThesisDocument {
  summary: string;
  instruments: ThesisInstrument[];
  evidence: { symbols: string[]; keywords: string[] };
  pillars: ThesisPillar[];
  killConditions: ThesisKillCondition[];
  catalysts: ThesisCatalyst[];
  target?: { price?: number; note?: string };
  entry?: { date?: string; price?: number };
}

interface ThesisOutcome {
  verdict: "right" | "wrong" | "lucky" | "unlucky";
  returnPct?: number;
  lesson?: string;
}

interface ThesisEditor {
  id: string;
  username: string | null;
  displayName: string;
}

export interface CloudThesis {
  id: string;
  owner: CloudNoteOwner;
  title: string;
  status: ThesisStatus;
  conviction: number;
  horizon: string | null;
  reviewEveryDays: number;
  document: ThesisDocument;
  outcome: ThesisOutcome | null;
  health: ThesisHealth;
  revision: number;
  /** Signals waiting for a verdict. */
  openSignals: number;
  createdBy: string;
  updatedBy: ThesisEditor;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  closedAt: string | null;
}

type ThesisSignalTargetKind = "pillar" | "kill" | "catalyst" | "thesis";
type ThesisSignalVerdict = "supports" | "challenges" | "breaks" | "neutral";
type ThesisSignalStatus = "open" | "accepted" | "dismissed" | "snoozed" | "noted";

interface ThesisSignalSource {
  kind: "news" | "filing" | "transcript" | "metric" | "review" | "user";
  id?: string;
  title?: string;
  url?: string;
  at?: string;
  symbol?: string;
}

export interface ThesisSignal {
  id: string;
  thesisId: string;
  targetKind: ThesisSignalTargetKind;
  targetId: string | null;
  verdict: ThesisSignalVerdict;
  confidence: number | null;
  reason: string;
  source: ThesisSignalSource | null;
  origin: "ai" | "rule" | "user";
  status: ThesisSignalStatus;
  resolutionNote: string | null;
  createdBy: ThesisEditor | null;
  resolvedBy: ThesisEditor | null;
  createdAt: string;
  resolvedAt: string | null;
  snoozedUntil: string | null;
}

export interface ThesisDraft extends ThesisDocument {
  title: string;
  horizon: string | null;
}

export interface ThesisPatch {
  title?: string;
  status?: ThesisStatus;
  conviction?: number;
  horizon?: string | null;
  reviewEveryDays?: number;
  document?: ThesisDocument;
  outcome?: ThesisOutcome | null;
  note?: string | null;
  reviewed?: boolean;
}
