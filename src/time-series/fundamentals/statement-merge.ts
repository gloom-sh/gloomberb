// Merges the statements a source reports for one fiscal period into a single row.
import type { FinancialStatement } from "../../types/financials";
import { areNearbyFinancialPeriodEnds, completeAvailability, statementFieldAvailability } from "../../utils/financial-statements";
import { copyIncomeField, incomeFieldKnowledgeDate, incomeFieldOwner, isIncomeStatementField } from "../../utils/income-statement";
import { hasStatementGap, mergeStatementGaps } from "../../utils/statement-gaps";
import {
  completeStatementAvailability,
  type InternalStatement,
  NUMERIC_STATEMENT_FIELDS,
  type NumericStatementField,
  statementNumber,
} from "./statement";

function statementAvailabilityScore(statement: FinancialStatement): number {
  return Object.values(statement.fieldAvailability ?? {})
    .filter((value) => Number.isFinite(Date.parse(value)))
    .length + (Number.isFinite(Date.parse(statement.availableAt ?? "")) ? 1 : 0);
}

interface StatementFieldCandidate {
  statement: InternalStatement;
  value: number;
  availableAt?: string;
  derived: boolean;
}

function selectFieldCandidate(candidates: StatementFieldCandidate[]): StatementFieldCandidate {
  const reported = candidates.filter((candidate) => !candidate.derived);
  const qualityCandidates = reported.length > 0 ? reported : candidates;
  const dated = qualityCandidates.filter((candidate) => (
    Number.isFinite(Date.parse(candidate.availableAt ?? ""))
  ));
  const chronological = [...(dated.length > 0 ? dated : qualityCandidates)].sort((left, right) => (
    Date.parse(left.availableAt ?? "") - Date.parse(right.availableAt ?? "")
    || left.statement.date.localeCompare(right.statement.date)
  ));
  let selected = chronological[0]!;
  for (const candidate of chronological.slice(1)) {
    if (!Object.is(candidate.value, selected.value)) selected = candidate;
  }
  return selected;
}

function periodDateSource(statements: readonly InternalStatement[]): InternalStatement {
  return [...statements].sort((left, right) => {
    const availabilityDifference = statementAvailabilityScore(right) - statementAvailabilityScore(left);
    return availabilityDifference || left.date.localeCompare(right.date);
  })[0]!;
}

function mergeStatementPeriodGroup(statements: readonly InternalStatement[]): InternalStatement {
  const dateSource = periodDateSource(statements);
  const merged: InternalStatement = { date: dateSource.date, currency: dateSource.currency };
  const compatibleStatements = statements.filter((statement) => statement.currency === dateSource.currency);
  const derivedFields: NumericStatementField[] = [];
  const fieldAvailability: Record<string, string> = {};
  const record = merged as unknown as Record<string, unknown>;

  for (const field of NUMERIC_STATEMENT_FIELDS) {
    // A gap declared for the period is never filled from another report.
    if (!isIncomeStatementField(field) && compatibleStatements.some((statement) => hasStatementGap(statement, field))) continue;
    if (isIncomeStatementField(field)) {
      const qualified = compatibleStatements.filter(statement => statement.date === dateSource.date && incomeFieldOwner(field, statement));
      if (qualified.length) {
        const owner = [...qualified].sort((left, right) => incomeFieldKnowledgeDate(right, field).localeCompare(incomeFieldKnowledgeDate(left, field)))[0]!;
        copyIncomeField(merged, owner, field);
        const availability = statementFieldAvailability(owner, field);
        if (typeof merged[field] === "number" && availability) fieldAvailability[field] = availability;
        continue;
      }
    }
    const candidates = compatibleStatements.flatMap((statement): StatementFieldCandidate[] => {
      if (isIncomeStatementField(field) && statement.date !== dateSource.date
        && incomeFieldOwner(field, statement)) return [];
      const value = statementNumber(statement, field);
      if (value === null) return [];
      return [{
        statement,
        value,
        availableAt: statementFieldAvailability(statement, field),
        derived: statement.__timeSeriesDerivedFields?.includes(field) === true,
      }];
    });
    const verifiedEps = field === "eps" ? candidates.filter((candidate) => candidate.statement.epsBasis?.status === "split-adjusted") : [];
    const unresolvedEps = field === "eps" ? compatibleStatements.find((statement) => statement.epsBasis?.status === "unresolved") : undefined;
    if (unresolvedEps && verifiedEps.length === 0) {
      merged.epsBasis = unresolvedEps.epsBasis;
      continue;
    }
    if (candidates.length === 0) continue;
    const selected = selectFieldCandidate(verifiedEps.length ? verifiedEps : candidates);
    record[field] = selected.value;
    if (field === "eps" && selected.statement.epsBasis) merged.epsBasis = selected.statement.epsBasis;
    if (selected.availableAt) fieldAvailability[field] = selected.availableAt;
    if (selected.derived) derivedFields.push(field);
  }

  mergeStatementGaps(merged, compatibleStatements);
  merged.fieldAvailability = fieldAvailability;
  merged.availableAt = completeStatementAvailability(merged);
  if (NUMERIC_STATEMENT_FIELDS.every(field => statementNumber(merged, field) === null)) {
    // Even an empty statement can establish when a missing period became
    // known. Its empty field map still cannot date any numeric metric.
    merged.availableAt = completeAvailability([dateSource.availableAt]);
  }
  if (derivedFields.length > 0) merged.__timeSeriesDerivedFields = derivedFields;
  return merged;
}

export function mergeStatementsByPeriod(
  statements: readonly FinancialStatement[],
): InternalStatement[] {
  const groups: InternalStatement[][] = [];
  const sorted = [...statements].sort((left, right) => left.date.localeCompare(right.date));
  for (const statement of sorted) {
    const lastGroup = groups.at(-1);
    if (lastGroup && areNearbyFinancialPeriodEnds(lastGroup[0]!.date, statement.date)) {
      lastGroup.push(statement as InternalStatement);
    } else groups.push([statement as InternalStatement]);
  }
  return groups
    .map(mergeStatementPeriodGroup)
    .sort((left, right) => left.date.localeCompare(right.date));
}
