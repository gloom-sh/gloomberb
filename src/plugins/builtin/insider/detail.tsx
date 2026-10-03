import type { RefObject } from "react";
import { Box, Text, type ScrollBoxRenderable } from "../../../ui";
import { DetailScrollBody, KeyValueRow } from "../../../components";
import { colors } from "../../../theme/colors";
import { wrapTextLines } from "../../../utils/text-wrap";
import {
  buildInsiderTransactionDetailBody,
  formatFilingFormLabel,
  formatFilingShortDate,
} from "../sec/filing-display";
import { isAmendedInsiderFiling } from "./amendments";
import type { InsiderReportingOwner } from "./insider-data";
import { buildInsiderDisclosureText, insiderDisplayName, isInsiderDisclosureOnly } from "./model";
import type { InsiderTableRow } from "./table-model";
import { insiderToneColor } from "./table";

/** Every role an owner filed: the officer title, plus Director and 10% owner when the boxes add them. */
function ownerRoles(owner: InsiderReportingOwner): string {
  const title = owner.title.trim();
  return [
    title,
    owner.director && !/\bdirector\b/i.test(title) ? "Director" : "",
    owner.tenPercentOwner && !/10\s*%/.test(title) ? "10% owner" : "",
  ].filter(Boolean).join(", ");
}

function fullTitle(row: InsiderTableRow): string {
  const owners = row.entry.disclosure?.reportingOwners ?? row.entry.transaction?.reportingOwners ?? [];
  const roles = owners.map(ownerRoles).filter(Boolean);
  if (roles.length) return [...new Set(roles)].join("; ");
  return row.entry.transaction?.title ?? "";
}

export function insiderDetailTitle(row: InsiderTableRow): string {
  if (row.entry.isLoading) return `Loading ${formatFilingFormLabel(row.entry.filing.form)} filing...`;
  return insiderDisplayName(row.entry) ?? row.name;
}

function detailMeta(row: InsiderTableRow): string[] {
  const { entry } = row;
  const amendment = isAmendedInsiderFiling(entry);
  return [
    fullTitle(row),
    `Filed ${formatFilingShortDate(entry.filing.filingDate)}`,
    `Accession ${entry.filing.accessionNumber}`,
    formatFilingFormLabel(entry.filing.form),
    ...(amendment ? ["Unreconciled amendment"] : []),
    ...(entry.disclosure?.originalFilingDate ? [`Original filed ${entry.disclosure.originalFilingDate}`] : []),
  ].filter(Boolean);
}

interface DetailField {
  label: string;
  value: string;
}

/** The transaction's fields as label and value, from the same lines the SEC pane prints. */
function detailFields(row: InsiderTableRow): DetailField[] {
  const { transaction } = row.entry;
  if (!transaction) return [];
  const fields = buildInsiderTransactionDetailBody(transaction).split("\n").map((line) => {
    const split = line.indexOf(": ");
    return split < 0 ? { label: "", value: line } : { label: line.slice(0, split), value: line.slice(split + 2) };
  });
  // One box for the whole form, so it says what the filer checked rather than which line it covers.
  if (transaction.rule10b51 != null) fields.push({ label: "10b5-1 Box", value: transaction.rule10b51 ? "Checked" : "Not checked" });
  return fields;
}

/** Remarks and footnotes, or what the row has instead of a transaction. */
function detailText(row: InsiderTableRow): string {
  const { entry } = row;
  const disclosureText = buildInsiderDisclosureText(entry);
  if (entry.transaction) return disclosureText;
  if (entry.isLoading) return "Loading filing content...";
  if (disclosureText) return disclosureText;
  return isInsiderDisclosureOnly(entry)
    ? "No transaction lines reported."
    : "This Form 4 filing could not be parsed into a transaction summary.";
}

const FIELD_LABEL_WIDTH = 20;

/** One Form 4 line read in full: who, the filing, every field, then remarks and footnotes. */
export function InsiderDetail({ row, width, scrollRef }: { row: InsiderTableRow; width: number; scrollRef: RefObject<ScrollBoxRenderable | null> }) {
  const textWidth = Math.max(width - 2, 12);
  const fields = detailFields(row);
  const text = detailText(row);
  const toneColor = row.tone === "neutral" ? undefined : insiderToneColor(row.tone);
  return (
    <DetailScrollBody ref={scrollRef} resetScrollKey={row.id}>
      <Box flexDirection="column">
        {detailMeta(row).flatMap((entry) => wrapTextLines(entry, textWidth, 2)).map((line, index) => (
          <Box key={`meta-${index}`} height={1}>
            <Text fg={colors.textMuted}>{line}</Text>
          </Box>
        ))}
        {fields.length > 0 && <Box height={1} />}
        {fields.map((field, index) => (
          <KeyValueRow
            key={`field-${index}`}
            label={field.label}
            value={field.value}
            width={textWidth}
            labelWidth={Math.min(FIELD_LABEL_WIDTH, Math.floor(textWidth / 2))}
            emphasis={false}
            color={index === 0 ? toneColor : undefined}
          />
        ))}
        {text && <Box height={1} />}
        {text.split("\n").flatMap((line) => wrapTextLines(line, textWidth)).map((line, index) => (
          <Box key={`text-${index}`} height={1}>
            <Text fg={colors.text}>{line}</Text>
          </Box>
        ))}
      </Box>
    </DetailScrollBody>
  );
}
