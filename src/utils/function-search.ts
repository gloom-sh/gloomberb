import type { PaneTemplateDef } from "../types/plugin";

const STOP_WORDS = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with"]);

export function functionQueryTerms(query: string): string[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const named = words.filter((word) => !STOP_WORDS.has(word));
  return named.length > 0 ? named : words;
}

function searchStem(text: string): string {
  return text.replace(/\bcompar(?:isons?|ing|e[ds]?)\b/g, "compare");
}

function startsWord(text: string, phrase: string): boolean {
  for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) return true;
  }
  return false;
}

export function matchesFunctionPhrase(text: string, phrase: string): boolean {
  const target = text.toLowerCase();
  const query = phrase.toLowerCase();
  return !query || startsWord(target, query) || startsWord(searchStem(target), searchStem(query));
}

export function matchesFunctionSearch(query: string, fields: readonly string[]): boolean {
  return functionQueryTerms(query).every((term) => fields.some((field) => matchesFunctionPhrase(field, term)));
}

export function paneTemplateSearchFields(template: PaneTemplateDef, pane?: { headless?: PaneTemplateDef["headless"] }): string[] {
  const discovery = (template.headless ?? pane?.headless)?.discovery;
  return [...template.keywords ?? [], template.label, template.description, template.paneId, template.id,
    template.shortcut?.prefix ?? "", ...template.shortcut?.aliases ?? [],
    ...discovery?.aliases ?? [], ...discovery?.suggestFor ?? [], ...discovery?.intents ?? [],
    ...discovery?.opens?.flatMap((opening) => opening.words) ?? []];
}
