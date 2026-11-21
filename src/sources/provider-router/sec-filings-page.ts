import type { SecFilingItem, SecFilingsPage, SecFilingsPageQuery } from "../../types/data-provider";

/** A form as the page's filter compares it: `4/A` is `4`. */
const formBase = (form: string) => form.trim().toUpperCase().replace(/\/A$/, "");

/**
 * `getSecFilingsPage` cut from a whole list, for a source that lists a
 * company's filings but has no page of some forms: the forms asked for, each
 * with its amendment, from `offset`, and every form's newest filing day.
 */
export function secFilingsPageFromList(filings: readonly SecFilingItem[], query: SecFilingsPageQuery): SecFilingsPage {
  const forms = new Set(query.forms.map(formBase).filter(Boolean));
  const matching = forms.size ? filings.filter((filing) => forms.has(formBase(filing.form))) : [...filings];
  const offset = Math.max(0, query.offset ?? 0);
  const page = matching.slice(offset, offset + Math.max(0, query.limit));
  const newestByForm: Record<string, string> = {};
  for (const filing of filings) {
    const time = new Date(filing.filingDate).getTime();
    const form = filing.form.trim();
    if (!form || !Number.isFinite(time)) continue;
    const day = new Date(time).toISOString().slice(0, 10);
    if (!newestByForm[form] || day > newestByForm[form]) newestByForm[form] = day;
  }
  return { filings: page, hasMore: offset + page.length < matching.length, nextOffset: offset + page.length, newestByForm };
}
