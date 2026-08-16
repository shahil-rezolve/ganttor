/**
 * Column detection for Jira CSV exports.
 *
 * Jira's "Export → CSV (all fields)" output has three properties that break naive
 * parsers, and all three are handled here rather than downstream:
 *
 * 1. **Repeated headers.** A multi-value field emits one column *per value*, all with
 *    the same name — an issue blocking three others produces three
 *    `Outward issue link (Blocks)` columns. So a field maps to a *list* of column
 *    indices, never to one.
 * 2. **Renamed custom fields.** Story points arrive as `Custom field (Story Points)`,
 *    `Story Points`, or `Story point estimate` depending on the instance's age.
 * 3. **Localised or reordered headers.** Position is never assumed; every column is
 *    found by matching its name.
 *
 * Detection is a guess, so it produces a `ColumnMapping` the user can correct in the
 * import wizard before anything is committed.
 */

/** The fields Ganttor can use. Everything else in the export is ignored. */
export type FieldKey =
  | 'key'
  | 'summary'
  | 'issueType'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'startDate'
  | 'dueDate'
  | 'storyPoints'
  | 'originalEstimate'
  | 'parent'
  | 'epicLink'
  | 'blocks'
  | 'blockedBy'
  | 'sprint'
  | 'labels';

export interface FieldSpec {
  key: FieldKey;
  label: string;
  /** What the field is for, shown in the mapping step. */
  hint: string;
  /** Lower-cased header names, best candidate first. */
  aliases: string[];
  /** True when the field legitimately occupies several columns at once. */
  multi?: boolean;
  required?: boolean;
}

export const FIELD_SPECS: readonly FieldSpec[] = [
  {
    key: 'key',
    label: 'Issue key',
    hint: 'The Jira key, e.g. BRAIN-123. Used as the task’s stable identity.',
    aliases: ['issue key', 'key'],
    required: true,
  },
  {
    key: 'summary',
    label: 'Summary',
    hint: 'The task name shown in the chart.',
    aliases: ['summary', 'title'],
    required: true,
  },
  {
    key: 'issueType',
    label: 'Issue type',
    hint: 'Epics become summary rows; issues typed as a milestone become markers.',
    aliases: ['issue type', 'issuetype', 'type'],
  },
  {
    key: 'status',
    label: 'Status',
    hint: 'Mapped onto Ganttor’s on-track / at-risk / delayed / done scheme.',
    aliases: ['status'],
  },
  {
    key: 'priority',
    label: 'Priority',
    hint: 'Used by the priority colour mode.',
    aliases: ['priority'],
  },
  {
    key: 'assignee',
    label: 'Assignee',
    hint: 'Becomes a resource, and drives the workload view.',
    aliases: ['assignee', 'assignee name', 'assignee display name'],
    multi: true,
  },
  {
    key: 'startDate',
    label: 'Start date',
    hint: 'Anchors the task. Without it, dates come from dependencies alone.',
    aliases: ['start date', 'custom field (start date)', 'target start', 'custom field (target start)'],
  },
  {
    key: 'dueDate',
    label: 'Due date',
    hint: 'With a start date, sets duration. Alone, it back-calculates one.',
    aliases: ['due date', 'duedate', 'target end', 'custom field (target end)'],
  },
  {
    key: 'storyPoints',
    label: 'Story points',
    hint: 'Converted to working days by the points factor when no dates exist.',
    aliases: [
      'story points',
      'custom field (story points)',
      'story point estimate',
      'custom field (story point estimate)',
    ],
  },
  {
    key: 'originalEstimate',
    label: 'Original estimate',
    hint: 'Seconds of estimated work; a more precise duration source than points.',
    aliases: ['original estimate', 'σoriginal estimate', 'timeoriginalestimate'],
  },
  {
    key: 'parent',
    label: 'Parent',
    hint: 'Subtask parent. Becomes WBS nesting.',
    aliases: ['parent', 'parent key', 'parent id', 'parent summary'],
  },
  {
    key: 'epicLink',
    label: 'Epic link',
    hint: 'Epic membership. Also becomes WBS nesting.',
    aliases: ['epic link', 'custom field (epic link)', 'parent epic'],
  },
  {
    key: 'blocks',
    label: 'Blocks',
    hint: 'Each becomes a finish-to-start dependency into the named issue.',
    aliases: ['outward issue link (blocks)', 'blocks'],
    multi: true,
  },
  {
    key: 'blockedBy',
    label: 'Is blocked by',
    hint: 'Each becomes a finish-to-start dependency from the named issue.',
    aliases: ['inward issue link (blocks)', 'is blocked by', 'blocked by'],
    multi: true,
  },
  {
    key: 'sprint',
    label: 'Sprint',
    hint: 'Used as the phase for the phase colour mode.',
    aliases: ['sprint', 'custom field (sprint)'],
    multi: true,
  },
  {
    key: 'labels',
    label: 'Labels',
    hint: 'Falls back to the phase dimension when there is no sprint.',
    aliases: ['labels'],
    multi: true,
  },
];

/** Which CSV column indices supply each field. Empty means "not mapped". */
export type ColumnMapping = Record<FieldKey, number[]>;

export function emptyMapping(): ColumnMapping {
  const mapping = {} as ColumnMapping;
  for (const spec of FIELD_SPECS) mapping[spec.key] = [];
  return mapping;
}

const normalize = (header: string): string =>
  header
    .replace(/^﻿/, '') // Jira exports are UTF-8 with a BOM.
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * Best-effort mapping from a header row.
 *
 * Exact alias matches are taken first across all fields, so a header that is an exact
 * match for one field is never stolen by another field's fuzzy match. Only then are
 * the remaining columns offered to substring matching.
 */
export function detectColumns(headers: readonly string[]): ColumnMapping {
  const mapping = emptyMapping();
  const normalized = headers.map(normalize);
  const claimed = new Set<number>();

  for (const spec of FIELD_SPECS) {
    for (const alias of spec.aliases) {
      for (let i = 0; i < normalized.length; i++) {
        if (claimed.has(i) || normalized[i] !== alias) continue;
        mapping[spec.key].push(i);
        claimed.add(i);
        if (!spec.multi) break;
      }
      if (mapping[spec.key].length > 0 && !spec.multi) break;
    }
  }

  for (const spec of FIELD_SPECS) {
    if (mapping[spec.key].length > 0) continue;
    for (const alias of spec.aliases) {
      for (let i = 0; i < normalized.length; i++) {
        if (claimed.has(i) || !normalized[i]!.includes(alias)) continue;
        mapping[spec.key].push(i);
        claimed.add(i);
        if (!spec.multi) break;
      }
      if (mapping[spec.key].length > 0 && !spec.multi) break;
    }
  }

  return mapping;
}

/** First non-empty value for a field. */
export function valueOf(
  row: readonly string[],
  mapping: ColumnMapping,
  field: FieldKey,
): string | null {
  for (const index of mapping[field]) {
    const value = row[index]?.trim();
    if (value) return value;
  }
  return null;
}

/** Every non-empty value for a field — the repeated-column case. */
export function valuesOf(
  row: readonly string[],
  mapping: ColumnMapping,
  field: FieldKey,
): string[] {
  const values: string[] = [];
  for (const index of mapping[field]) {
    const value = row[index]?.trim();
    if (value) values.push(value);
  }
  return values;
}

export function missingRequiredFields(mapping: ColumnMapping): FieldSpec[] {
  return FIELD_SPECS.filter((spec) => spec.required && mapping[spec.key].length === 0);
}
