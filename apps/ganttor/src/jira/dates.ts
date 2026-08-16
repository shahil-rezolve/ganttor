/**
 * Parsing the date formats Jira actually exports.
 *
 * A Jira instance emits dates in whatever format its locale is configured for, and the
 * CSV carries no hint about which. Rather than guess a locale, each known shape is
 * matched by an explicit pattern and anything unrecognised is reported as unparsed —
 * a task with no date is honest, whereas a task with the wrong date is a silent bug.
 *
 * The ambiguous case is `03/04/2026`, which is 3 April in most of the world and 4 March
 * in the US. Both readings are returned so the import wizard can ask once and apply the
 * answer to the whole file.
 */

import { toDayNum, type DayNum } from '@ganttor/gantt/core';

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export type DayFirst = boolean;

export interface ParsedDate {
  day: DayNum;
  /** True when the input was `nn/nn/nnnn` and the reading depended on `dayFirst`. */
  ambiguous: boolean;
}

/** Jira's default: `12/Mar/26 3:04 PM`, also `12/Mar/2026`. */
const JIRA_DEFAULT = /^(\d{1,2})\/([A-Za-z]{3,4})\/(\d{2,4})/;
/** ISO, from API-derived exports: `2026-03-12` or `2026-03-12T15:04:00.000+0000`. */
const ISO = /^(\d{4})-(\d{2})-(\d{2})/;
/** Slash or dot numeric: `12/03/2026`, `03.12.2026`, `12-03-2026`. */
const NUMERIC = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/;
/** Long form: `12 March 2026`, `March 12, 2026`. */
const LONG_DMY = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/;
const LONG_MDY = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/;

/**
 * Parses one Jira date cell. Returns `null` for an empty or unrecognised value.
 *
 * `dayFirst` only affects the ambiguous all-numeric form; every other shape is
 * unambiguous and ignores it.
 */
export function parseJiraDate(raw: string, dayFirst: DayFirst = true): ParsedDate | null {
  const value = raw.trim();
  if (!value) return null;

  const iso = ISO.exec(value);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]), false);

  const jira = JIRA_DEFAULT.exec(value);
  if (jira) {
    const month = MONTHS[jira[2]!.toLowerCase()];
    if (month === undefined) return null;
    return build(expandYear(Number(jira[3])), month, Number(jira[1]), false);
  }

  const dmy = LONG_DMY.exec(value);
  if (dmy) {
    const month = monthFromName(dmy[2]!);
    if (month === null) return null;
    return build(Number(dmy[3]), month, Number(dmy[1]), false);
  }

  const mdy = LONG_MDY.exec(value);
  if (mdy) {
    const month = monthFromName(mdy[1]!);
    if (month === null) return null;
    return build(Number(mdy[3]), month, Number(mdy[2]), false);
  }

  const numeric = NUMERIC.exec(value);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = expandYear(Number(numeric[3]));
    // A value over 12 can only be the day, which settles the order regardless of hint.
    if (a > 12) return build(year, b, a, false);
    if (b > 12) return build(year, a, b, false);
    return dayFirst ? build(year, b, a, true) : build(year, a, b, true);
  }

  return null;
}

function build(year: number, month: number, day: number, ambiguous: boolean): ParsedDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  try {
    return { day: toDayNum(iso), ambiguous };
  } catch {
    return null;
  }
}

function monthFromName(name: string): number | null {
  const key = name.toLowerCase().slice(0, 4);
  return MONTHS[key] ?? MONTHS[key.slice(0, 3)] ?? null;
}

/** Jira writes two-digit years; they are always this century in practice. */
function expandYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

/**
 * Does this file need the day/month question asked?
 *
 * Only if some value is genuinely ambiguous *and* no value in the file settles it. A
 * single `25/12/2026` proves the whole column is day-first, so the user is not asked.
 */
export function needsDayFirstPrompt(samples: readonly string[]): boolean {
  let sawAmbiguous = false;
  for (const sample of samples) {
    const value = sample.trim();
    if (!value) continue;
    const numeric = NUMERIC.exec(value);
    if (!numeric) continue;
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    if (a > 12 || b > 12) return false;
    sawAmbiguous = true;
  }
  return sawAmbiguous;
}
