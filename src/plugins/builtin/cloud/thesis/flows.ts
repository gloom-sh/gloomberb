import {
  ThesisConflictError,
  ThesisGoalpostError,
  type CloudNoteScope,
  type CloudThesis,
  type ThesisCatalyst,
  type ThesisDocument,
  type ThesisKillCondition,
  type ThesisPatch,
  type ThesisPillar,
  type ThesisSignal,
  type ThesisStatus,
} from "../../../../api-client";
import { ApiRequestError } from "../../../../api-client/errors";
import type { AppNotificationRequest } from "../../../../types/plugin";
import type { DialogApi } from "../../../../ui/dialog";
import { THESIS_METRIC_KEYS, THESIS_SERIES_KEYS, emptyDocument, itemId } from "./model";
import { confirm, promptChoice, promptNumber, promptSelect, promptText, promptTextarea } from "./prompts";
import { thesisStore } from "./store";

export interface FlowContext {
  dialog: DialogApi;
  notify: (request: AppNotificationRequest) => void;
  hasProAccess: boolean;
  openUpgrade: () => void;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && error.message) return error.message;
  return error instanceof Error && error.message ? error.message : fallback;
}

function failed(ctx: FlowContext, error: unknown, fallback: string): undefined {
  ctx.notify({ body: errorText(error, fallback), type: "error" });
  return undefined;
}

function needsPro(ctx: FlowContext, what: string): boolean {
  if (ctx.hasProAccess) return false;
  ctx.notify({
    body: `${what} needs Gloom Cloud Pro.`,
    type: "info",
    action: { label: "Upgrade", onClick: ctx.openUpgrade },
  });
  return true;
}

/**
 * Saves a patch, handling the two refusals the server can answer with: a
 * teammate's newer revision, and a fired kill condition moved without a note.
 */
export async function savePatch(
  ctx: FlowContext,
  thesis: CloudThesis,
  patch: ThesisPatch,
  options: { expectRevision?: boolean } = {},
): Promise<CloudThesis | undefined> {
  const expected = options.expectRevision === false ? undefined : thesis.revision;
  try {
    return await thesisStore.save(thesis.id, patch, expected);
  } catch (error) {
    if (error instanceof ThesisGoalpostError) {
      const note = await promptTextarea(ctx.dialog, {
        label: "A kill condition that fired is being reset",
        body: ["Say why. The note stays on the revision so the timeline shows the goalposts moved."],
        placeholder: "It was a one-off reclass, not a demand shortfall...",
      });
      if (!note) return undefined;
      return savePatch(ctx, thesis, { ...patch, note }, options);
    }
    if (error instanceof ThesisConflictError) {
      const editor = error.current?.updatedBy.username ? `@${error.current.updatedBy.username}` : error.current?.updatedBy.displayName ?? "a teammate";
      const choice = await promptChoice(ctx.dialog, `Edited by ${editor} since you opened it`, [
        { id: "reload", label: "Take their version", description: "Your change is dropped." },
        { id: "overwrite", label: "Overwrite with mine", description: "Their change is dropped." },
      ], "reload");
      if (choice === "overwrite") return savePatch(ctx, thesis, patch, { expectRevision: false });
      if (choice === "reload" && error.current) thesisStore.upsert(error.current);
      return undefined;
    }
    return failed(ctx, error, "Could not save the thesis.");
  }
}

function saveDocument(ctx: FlowContext, thesis: CloudThesis, document: ThesisDocument, note?: string) {
  return savePatch(ctx, thesis, { document, ...(note ? { note } : {}) });
}

export interface StartThesisInput {
  instruments: ReadonlyArray<{ symbol: string; exchange?: string; side?: "long" | "short" }>;
  scope: CloudNoteScope;
  /** Whether any of the instruments is held; sets watching vs active. */
  held: boolean;
  note?: string | null;
}

function describeInstruments(instruments: StartThesisInput["instruments"]): string {
  const symbols = instruments.map((entry) => entry.symbol.toUpperCase());
  if (symbols.length <= 2) return symbols.join(" and ");
  return `${symbols.slice(0, -1).join(", ")} and ${symbols[symbols.length - 1]}`;
}

function titleFor(instruments: StartThesisInput["instruments"]): string {
  const symbols = instruments.map((entry) => entry.symbol.toUpperCase());
  if (symbols.length === 1) return symbols[0]!;
  if (symbols.length <= 3) return symbols.join(" / ");
  return `${symbols[0]} +${symbols.length - 1}`;
}

/**
 * The first question: why. The thesis exists the moment it is answered,
 * with the answer as its summary, so it shows up at once. On Pro the draft
 * (pillars, kill conditions, catalysts) runs behind it and lands as the
 * next revision unless the person edited in the meantime.
 */
export async function startThesis(ctx: FlowContext, input: StartThesisInput): Promise<CloudThesis | undefined> {
  const instruments = input.instruments.map((entry) => ({ ...entry, symbol: entry.symbol.toUpperCase() }));
  if (instruments.length === 0) return undefined;
  const who = describeInstruments(instruments);
  const reasoning = await promptTextarea(ctx.dialog, {
    label: `Why ${input.held ? "do you own" : "would you buy"} ${who}?`,
    body: ctx.hasProAccess
      ? ["One or two sentences. Pillars, kill conditions, and catalysts are drafted from it and the company data."]
      : ["One or two sentences. You add pillars and kill conditions next.", "Pro drafts them for you."],
    placeholder: "Data center demand keeps compounding and nobody else has the software moat...",
  });
  if (!reasoning) return undefined;
  const document = { ...emptyDocument(instruments), summary: reasoning };
  let thesis: CloudThesis;
  try {
    thesis = await thesisStore.create({
      scope: input.scope,
      title: titleFor(instruments),
      status: input.held ? "active" : "watching",
      conviction: 5,
      horizon: null,
      document,
    });
  } catch (error) {
    return failed(ctx, error, "Could not create the thesis.");
  }
  if (!ctx.hasProAccess) {
    ctx.notify({ body: `Thesis started for ${who}. Add what must stay true and what would make you sell.`, type: "success" });
    return thesis;
  }
  ctx.notify({ body: `Thesis started for ${who}. Drafting pillars and kill conditions from the company data…`, type: "info" });
  void thesisStore.draft({ instruments, reasoning, note: input.note ?? null })
    .then(async (draft) => {
      const current = thesisStore.get(thesis.id);
      if (!current) return;
      if (current.revision !== thesis.revision) {
        ctx.notify({ body: `${thesis.title}: the draft is ready but you already edited, so it was not applied.`, type: "info" });
        return;
      }
      const { title, horizon, ...drafted } = draft;
      await thesisStore.save(thesis.id, {
        title: title || thesis.title,
        horizon,
        document: { ...drafted, summary: drafted.summary || reasoning },
        note: "Drafted from your reasoning and the company data.",
      }, thesis.revision);
      ctx.notify({
        body: `${title || thesis.title}: ${drafted.pillars.length} pillars, ${drafted.killConditions.length} kill conditions drafted. Edit anything that is not yours.`,
        type: "success",
      });
    })
    .catch((error) => {
      ctx.notify({ body: `${thesis.title}: ${errorText(error, "the draft failed")}. Your summary is kept; add pillars by hand.`, type: "error" });
    });
  return thesis;
}

export type MetaField = "title" | "status" | "conviction" | "horizon" | "cadence" | "summary" | "target";

export async function editMeta(ctx: FlowContext, thesis: CloudThesis, field?: MetaField): Promise<CloudThesis | undefined> {
  const chosen = field ?? (await promptChoice(ctx.dialog, "Edit", [
    { id: "title", label: "Title", detail: thesis.title },
    { id: "summary", label: "Summary" },
    { id: "conviction", label: "Conviction", detail: `${thesis.conviction}/10` },
    { id: "status", label: "Status", detail: thesis.status },
    { id: "horizon", label: "Horizon", detail: thesis.horizon ?? "none" },
    { id: "target", label: "Target", detail: thesis.document.target?.price ? String(thesis.document.target.price) : "none" },
    { id: "cadence", label: "Review every", detail: `${thesis.reviewEveryDays}d` },
  ])) as MetaField | undefined;
  if (!chosen) return undefined;
  switch (chosen) {
    case "title": {
      const title = await promptText(ctx.dialog, { label: "Title", defaultValue: thesis.title });
      return title ? savePatch(ctx, thesis, { title }) : undefined;
    }
    case "summary": {
      const summary = await promptTextarea(ctx.dialog, { label: "Summary", defaultValue: thesis.document.summary, placeholder: "Why, in a few sentences." });
      return summary === undefined ? undefined : saveDocument(ctx, thesis, { ...thesis.document, summary });
    }
    case "conviction": {
      const conviction = await promptNumber(ctx.dialog, { label: "Conviction, 1 to 10", defaultValue: thesis.conviction, min: 1, max: 10, integer: true });
      return conviction === undefined ? undefined : savePatch(ctx, thesis, { conviction });
    }
    case "status": {
      const status = await promptSelect(ctx.dialog, {
        label: "Status",
        defaultValue: thesis.status,
        options: [
          { label: "Watching: no position yet", value: "watching" },
          { label: "Active: position on", value: "active" },
        ],
      });
      return status ? savePatch(ctx, thesis, { status: status as ThesisStatus }) : undefined;
    }
    case "horizon": {
      const horizon = await promptText(ctx.dialog, { label: "Horizon", defaultValue: thesis.horizon ?? undefined, placeholder: "3y, through FY27, until the merger closes", required: false });
      return horizon === undefined ? undefined : savePatch(ctx, thesis, { horizon: horizon || null });
    }
    case "target": {
      const price = await promptNumber(ctx.dialog, { label: "Target price", defaultValue: thesis.document.target?.price, min: 0 });
      if (price === undefined) return undefined;
      return saveDocument(ctx, thesis, { ...thesis.document, target: { ...thesis.document.target, price: price || undefined } });
    }
    case "cadence": {
      const days = await promptNumber(ctx.dialog, { label: "Review every N days", defaultValue: thesis.reviewEveryDays, min: 7, max: 365, integer: true });
      return days === undefined ? undefined : savePatch(ctx, thesis, { reviewEveryDays: days });
    }
  }
}

export async function addPillar(ctx: FlowContext, thesis: CloudThesis): Promise<CloudThesis | undefined> {
  const text = await promptText(ctx.dialog, {
    label: "New pillar: what must stay true?",
    placeholder: "Gross margin holds above 70%",
  });
  if (!text) return undefined;
  const metricKey = await promptSelect(ctx.dialog, {
    label: "Bind it to a number?",
    defaultValue: "",
    options: [
      { label: "No, it is a judgment call", value: "", description: "The review weighs news and filings against it." },
      ...THESIS_METRIC_KEYS.map((entry) => ({ label: entry.label, value: entry.key, description: "Checked against the latest statements of the ticker it is about." })),
      ...THESIS_SERIES_KEYS.map((entry) => ({ label: entry.label, value: entry.key, description: "Checked against FRED; not tied to a ticker." })),
    ],
  });
  if (metricKey === undefined) return undefined;
  const pillar: ThesisPillar = { id: itemId(), text, kind: "qualitative", status: "unverified" };
  const isSeries = metricKey.startsWith("series:");
  if (metricKey) {
    const op = await promptSelect(ctx.dialog, {
      label: "Holds while the value is",
      options: [{ label: "at or above the bound", value: ">=" }, { label: "at or below the bound", value: "<=" }],
    });
    if (!op) return undefined;
    const unit = [...THESIS_METRIC_KEYS, ...THESIS_SERIES_KEYS].find((entry) => entry.key === metricKey)?.unit;
    const value = await promptNumber(ctx.dialog, { label: `Bound${unit ? ` (${unit})` : ""}`, placeholder: "70" });
    if (value === undefined) return undefined;
    pillar.kind = "metric";
    pillar.metric = { key: metricKey, op: op as ">=" | "<=", value, ...(unit ? { unit } : {}) };
  }
  // A claim can be about a held instrument or about a ticker the thesis only
  // listens to (a customer's capex); a macro series is about neither.
  const scopes = [...thesis.document.instruments.map((entry) => entry.symbol), ...thesis.document.evidence.symbols];
  if (!isSeries && scopes.length > 1) {
    const scope = await promptSelect(ctx.dialog, {
      label: "About which ticker?",
      defaultValue: "",
      options: [
        { label: "The thesis as a whole", value: "" },
        ...thesis.document.instruments.map((entry) => ({ label: entry.symbol, value: entry.symbol, description: "Held." })),
        ...thesis.document.evidence.symbols.map((symbol) => ({ label: symbol, value: symbol, description: "Evidence only, not held." })),
      ],
    });
    if (scope === undefined) return undefined;
    if (scope) pillar.scope = scope;
  }
  return saveDocument(ctx, thesis, { ...thesis.document, pillars: [...thesis.document.pillars, pillar] });
}

export async function editPillar(ctx: FlowContext, thesis: CloudThesis, pillar: ThesisPillar): Promise<CloudThesis | undefined> {
  const text = await promptText(ctx.dialog, { label: "Pillar", defaultValue: pillar.text });
  if (!text || text === pillar.text) return undefined;
  return saveDocument(ctx, thesis, {
    ...thesis.document,
    pillars: thesis.document.pillars.map((entry) => (entry.id === pillar.id ? { ...entry, text } : entry)),
  });
}

export function setPillarStatus(ctx: FlowContext, thesis: CloudThesis, pillar: ThesisPillar, status: ThesisPillar["status"]) {
  return saveDocument(ctx, thesis, {
    ...thesis.document,
    pillars: thesis.document.pillars.map((entry) => (entry.id === pillar.id ? { ...entry, status } : entry)),
  });
}

export async function addKillCondition(ctx: FlowContext, thesis: CloudThesis): Promise<CloudThesis | undefined> {
  const text = await promptText(ctx.dialog, {
    label: "New kill condition: what would make you sell?",
    body: ["Make it something you could not argue with later."],
    placeholder: "Gross margin under 65% two quarters running",
  });
  if (!text) return undefined;
  const condition: ThesisKillCondition = { id: itemId(), text, triggered: false };
  return saveDocument(ctx, thesis, { ...thesis.document, killConditions: [...thesis.document.killConditions, condition] });
}

export async function editKillCondition(ctx: FlowContext, thesis: CloudThesis, condition: ThesisKillCondition): Promise<CloudThesis | undefined> {
  const text = await promptText(ctx.dialog, { label: "Kill condition", defaultValue: condition.text });
  if (!text || text === condition.text) return undefined;
  return saveDocument(ctx, thesis, {
    ...thesis.document,
    killConditions: thesis.document.killConditions.map((entry) => (entry.id === condition.id ? { ...entry, text } : entry)),
  });
}

/** Firing is one keystroke. Un-firing goes through the goalpost rule on the server. */
export async function toggleKillCondition(ctx: FlowContext, thesis: CloudThesis, condition: ThesisKillCondition): Promise<CloudThesis | undefined> {
  if (!condition.triggered) {
    const sure = await confirm(ctx.dialog, {
      title: "Mark this kill condition as fired?",
      body: [condition.text, "", "The thesis becomes BROKEN. Resetting it later needs a note."],
      confirmLabel: "It fired",
      danger: true,
    });
    if (!sure) return undefined;
  }
  return saveDocument(ctx, thesis, {
    ...thesis.document,
    killConditions: thesis.document.killConditions.map((entry) => (entry.id === condition.id ? { ...entry, triggered: !entry.triggered } : entry)),
  });
}

export async function addCatalyst(ctx: FlowContext, thesis: CloudThesis): Promise<CloudThesis | undefined> {
  const text = await promptText(ctx.dialog, { label: "New catalyst: what should happen?", placeholder: "Q3 earnings show DC revenue above $30B" });
  if (!text) return undefined;
  const date = await promptText(ctx.dialog, { label: "By when? (YYYY-MM-DD, or leave empty)", required: false, placeholder: "2026-11-20" });
  if (date === undefined) return undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    ctx.notify({ body: "Dates are YYYY-MM-DD.", type: "error" });
    return undefined;
  }
  const catalyst: ThesisCatalyst = { id: itemId(), text, ...(date ? { date } : {}), status: "pending" };
  return saveDocument(ctx, thesis, { ...thesis.document, catalysts: [...thesis.document.catalysts, catalyst] });
}

export async function editCatalyst(ctx: FlowContext, thesis: CloudThesis, catalyst: ThesisCatalyst): Promise<CloudThesis | undefined> {
  const text = await promptText(ctx.dialog, { label: "Catalyst", defaultValue: catalyst.text });
  if (!text) return undefined;
  const date = await promptText(ctx.dialog, { label: "By when? (YYYY-MM-DD, or leave empty)", defaultValue: catalyst.date, required: false });
  if (date === undefined) return undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    ctx.notify({ body: "Dates are YYYY-MM-DD.", type: "error" });
    return undefined;
  }
  return saveDocument(ctx, thesis, {
    ...thesis.document,
    catalysts: thesis.document.catalysts.map((entry) => (entry.id === catalyst.id ? { ...entry, text, date: date || undefined } : entry)),
  });
}

export function setCatalystStatus(ctx: FlowContext, thesis: CloudThesis, catalyst: ThesisCatalyst, status: ThesisCatalyst["status"]) {
  return saveDocument(ctx, thesis, {
    ...thesis.document,
    catalysts: thesis.document.catalysts.map((entry) => (entry.id === catalyst.id ? { ...entry, status } : entry)),
  });
}

export type DocumentItem =
  | { kind: "pillar"; item: ThesisPillar }
  | { kind: "kill"; item: ThesisKillCondition }
  | { kind: "catalyst"; item: ThesisCatalyst };

export async function removeItem(ctx: FlowContext, thesis: CloudThesis, target: DocumentItem): Promise<CloudThesis | undefined> {
  const sure = await confirm(ctx.dialog, {
    title: `Remove this ${target.kind === "kill" ? "kill condition" : target.kind}?`,
    body: target.item.text,
    confirmLabel: "Remove",
    danger: true,
  });
  if (!sure) return undefined;
  const document = { ...thesis.document };
  if (target.kind === "pillar") document.pillars = document.pillars.filter((entry) => entry.id !== target.item.id);
  if (target.kind === "kill") document.killConditions = document.killConditions.filter((entry) => entry.id !== target.item.id);
  if (target.kind === "catalyst") document.catalysts = document.catalysts.filter((entry) => entry.id !== target.item.id);
  return saveDocument(ctx, thesis, document);
}

export async function addInstrument(ctx: FlowContext, thesis: CloudThesis, kind: "instrument" | "evidence"): Promise<CloudThesis | undefined> {
  const symbol = (await promptText(ctx.dialog, {
    label: kind === "instrument" ? "Add an instrument this thesis holds" : "Add a ticker whose news is evidence",
    body: kind === "evidence" ? ["Customers, competitors, suppliers. Not held, only listened to."] : undefined,
    placeholder: "MSFT",
  }))?.toUpperCase();
  if (!symbol) return undefined;
  const document = { ...thesis.document };
  if (kind === "instrument") {
    if (document.instruments.some((entry) => entry.symbol === symbol)) return undefined;
    const role = await promptSelect(ctx.dialog, {
      label: `${symbol} is`,
      options: [
        { label: "Long, core", value: "long:core" },
        { label: "Short, core", value: "short:core" },
        { label: "A hedge", value: "long:hedge" },
      ],
    });
    if (!role) return undefined;
    const [side, instrumentRole] = role.split(":") as ["long" | "short", "core" | "hedge"];
    document.instruments = [...document.instruments, { symbol, side, role: instrumentRole }];
    document.evidence = { ...document.evidence, symbols: document.evidence.symbols.filter((entry) => entry !== symbol) };
  } else {
    if (document.instruments.some((entry) => entry.symbol === symbol) || document.evidence.symbols.includes(symbol)) return undefined;
    document.evidence = { ...document.evidence, symbols: [...document.evidence.symbols, symbol] };
  }
  return saveDocument(ctx, thesis, document);
}

export async function removeSymbol(ctx: FlowContext, thesis: CloudThesis): Promise<CloudThesis | undefined> {
  const options = [
    ...thesis.document.instruments.map((entry) => ({ label: `${entry.symbol} (${entry.side}, ${entry.role})`, value: `i:${entry.symbol}` })),
    ...thesis.document.evidence.symbols.map((symbol) => ({ label: `${symbol} (evidence)`, value: `e:${symbol}` })),
  ];
  if (options.length === 0) return undefined;
  const choice = await promptSelect(ctx.dialog, { label: "Remove which symbol?", options });
  if (!choice) return undefined;
  const [kind, symbol] = choice.split(":") as ["i" | "e", string];
  const document = { ...thesis.document };
  if (kind === "i") {
    if (document.instruments.length === 1) {
      ctx.notify({ body: "A thesis keeps at least one instrument.", type: "error" });
      return undefined;
    }
    document.instruments = document.instruments.filter((entry) => entry.symbol !== symbol);
    document.pillars = document.pillars.map((pillar) => (pillar.scope === symbol ? { ...pillar, scope: undefined } : pillar));
  } else {
    document.evidence = { ...document.evidence, symbols: document.evidence.symbols.filter((entry) => entry !== symbol) };
  }
  return saveDocument(ctx, thesis, document);
}

export async function closeThesis(ctx: FlowContext, thesis: CloudThesis): Promise<CloudThesis | undefined> {
  const verdict = await promptSelect(ctx.dialog, {
    label: "How did it go?",
    body: ["Separate the decision from the result."],
    options: [
      { label: "Right: good call, good outcome", value: "right" },
      { label: "Wrong: bad call, bad outcome", value: "wrong" },
      { label: "Lucky: bad call, good outcome", value: "lucky" },
      { label: "Unlucky: good call, bad outcome", value: "unlucky" },
    ],
  });
  if (!verdict) return undefined;
  const returnPct = await promptNumber(ctx.dialog, { label: "Return (%)", placeholder: "42 or -18", min: -100 });
  if (returnPct === undefined) return undefined;
  const lesson = await promptTextarea(ctx.dialog, { label: "What would you do differently?", placeholder: "Optional. Two sentences beat two pages." });
  return savePatch(ctx, thesis, {
    status: "closed",
    outcome: { verdict: verdict as "right" | "wrong" | "lucky" | "unlucky", returnPct, ...(lesson ? { lesson } : {}) },
  });
}

export async function deleteThesis(ctx: FlowContext, thesis: CloudThesis): Promise<boolean> {
  const sure = await confirm(ctx.dialog, {
    title: `Delete the ${thesis.title} thesis?`,
    body: "Its history and signals go with it. Closing keeps the record.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!sure) return false;
  try {
    await thesisStore.remove(thesis.id);
    return true;
  } catch (error) {
    failed(ctx, error, "Could not delete the thesis.");
    return false;
  }
}

export async function resolveSignal(ctx: FlowContext, thesis: CloudThesis, signal: ThesisSignal): Promise<CloudThesis | undefined> {
  const applies = signal.targetKind !== "thesis" && signal.verdict !== "neutral";
  const choice = await promptChoice(ctx.dialog, "Your ruling", [
    {
      id: "accepted",
      label: "Accept",
      description: applies
        ? signal.verdict === "breaks"
          ? signal.targetKind === "kill" ? "The kill condition fired." : signal.targetKind === "catalyst" ? "The catalyst was missed." : "The pillar is broken."
          : signal.verdict === "challenges"
            ? signal.targetKind === "kill" ? "Noted as getting close. The condition stays unfired." : signal.targetKind === "catalyst" ? "The catalyst was missed." : "The pillar is weakening."
            : "Confirmed."
        : "Noted.",
    },
    { id: "dismissed", label: "Dismiss", description: "Not material, or already priced in. Say why so it is not raised again." },
    { id: "snoozed", label: "Snooze a week", description: "Ask again after the next data point." },
  ], "accepted");
  if (!choice) return undefined;
  let note: string | undefined;
  if (choice === "dismissed") {
    note = await promptText(ctx.dialog, { label: "Why dismiss it?", placeholder: "Already in the guide; one-off; not the segment that matters", required: false });
    if (note === undefined) return undefined;
  }
  try {
    const result = await thesisStore.resolveSignal(thesis.id, signal.id, {
      status: choice as "accepted" | "dismissed" | "snoozed",
      ...(note ? { note } : {}),
      ...(choice === "snoozed" ? { snoozeDays: 7 } : {}),
    });
    return result.thesis;
  } catch (error) {
    return failed(ctx, error, "Could not resolve the signal.");
  }
}

export async function challenge(ctx: FlowContext, thesis: CloudThesis, target: DocumentItem | null): Promise<boolean> {
  const verdict = await promptSelect(ctx.dialog, {
    label: target ? `Your take on: ${target.item.text.slice(0, 60)}` : "Your take on the thesis",
    options: [
      { label: "It challenges this", value: "challenges" },
      { label: "It breaks this", value: "breaks" },
      { label: "It supports this", value: "supports" },
    ],
  });
  if (!verdict) return false;
  const reason = await promptTextarea(ctx.dialog, { label: "Evidence", placeholder: "What did you see, and where." });
  if (!reason) return false;
  try {
    await thesisStore.challenge(thesis.id, {
      targetKind: target?.kind ?? "thesis",
      targetId: target?.item.id ?? null,
      verdict: verdict as "challenges" | "breaks" | "supports",
      reason,
    });
    return true;
  } catch (error) {
    failed(ctx, error, "Could not file the challenge.");
    return false;
  }
}

export async function runReview(ctx: FlowContext, thesis: CloudThesis): Promise<boolean> {
  if (needsPro(ctx, "Reviewing a thesis")) return false;
  try {
    await thesisStore.review(thesis.id);
    ctx.notify({ body: `Reviewing ${thesis.title} against fundamentals, filings, and news. You get a card when it lands.`, type: "info" });
    return true;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 402) {
      needsPro(ctx, "Reviewing a thesis");
      return false;
    }
    failed(ctx, error, "The review could not start.");
    return false;
  }
}

export async function markReviewed(ctx: FlowContext, thesis: CloudThesis): Promise<CloudThesis | undefined> {
  return savePatch(ctx, thesis, { reviewed: true }, { expectRevision: false });
}
