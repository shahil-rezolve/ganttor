/**
 * The Jira import path, against CSV shaped the way Jira actually exports it:
 * repeated columns for multi-value fields, a BOM, Jira's `12/Mar/26` dates, an epic
 * hierarchy, and a link to an issue outside the export.
 */

import { describe, expect, it } from 'vitest';

import { schedule, toDayNum, toISO } from '@ganttor/gantt/core';

import { detectColumns, missingRequiredFields, valuesOf } from './columns.js';
import { needsDayFirstPrompt, parseJiraDate } from './dates.js';
import { DEFAULT_IMPORT_OPTIONS, importJiraRows } from './import.js';
import { parseCsv } from './parse.js';

/**
 * A realistic export. Note the two `Outward issue link (Blocks)` columns and two
 * `Sprint` columns — Jira emits one per value, both named identically.
 */
const CSV = `﻿Issue key,Summary,Issue Type,Status,Priority,Assignee,Custom field (Start date),Due date,Custom field (Story Points),Parent,Custom field (Epic Link),Outward issue link (Blocks),Outward issue link (Blocks),Sprint,Sprint
GNT-1,Platform epic,Epic,In Progress,High,,,,,,,,,,
GNT-2,Design the schema,Task,Done,High,Priya Raman,02/Mar/26,06/Mar/26,3,,GNT-1,GNT-3,GNT-4,Sprint 1,Sprint 2
GNT-3,Build the engine,Task,In Progress,Highest,Lena Brandt,,,8,,GNT-1,GNT-5,,Sprint 2,
GNT-4,Write the docs,Task,To Do,Low,Priya Raman,,,2,,GNT-1,,,,
GNT-5,Ship it,Milestone,To Do,Highest,,,10/Apr/26,,,,GNT-99,,,
GNT-6,Orphan subtask,Sub-task,Blocked,Medium,Tom Okafor,,,1,GNT-3,,,,,`;

const parsed = parseCsv(CSV);
const mapping = detectColumns(parsed.headers);

describe('CSV parsing', () => {
  it('strips the BOM so the first header is usable', () => {
    expect(parsed.headers[0]).toBe('Issue key');
  });

  it('keeps every row', () => {
    expect(parsed.rows).toHaveLength(6);
  });

  it('preserves repeated columns instead of collapsing them', () => {
    const blocks = parsed.headers.filter((h) => h === 'Outward issue link (Blocks)');
    expect(blocks).toHaveLength(2);
  });
});

describe('column detection', () => {
  it('finds every required field', () => {
    expect(missingRequiredFields(mapping)).toEqual([]);
  });

  it('maps a renamed custom field', () => {
    expect(mapping.storyPoints).toHaveLength(1);
    expect(parsed.headers[mapping.storyPoints[0]!]).toBe('Custom field (Story Points)');
  });

  it('maps a multi-value field to all of its columns', () => {
    expect(mapping.blocks).toHaveLength(2);
    expect(mapping.sprint).toHaveLength(2);
  });

  it('reads every value of a repeated column', () => {
    const designRow = parsed.rows[1]!;
    expect(valuesOf(designRow, mapping, 'blocks')).toEqual(['GNT-3', 'GNT-4']);
    expect(valuesOf(designRow, mapping, 'sprint')).toEqual(['Sprint 1', 'Sprint 2']);
  });

  it('does not let a fuzzy match steal an exactly-named column', () => {
    // "Parent" and "Custom field (Epic Link)" are distinct fields with similar intent.
    expect(mapping.parent).not.toEqual(mapping.epicLink);
    expect(parsed.headers[mapping.parent[0]!]).toBe('Parent');
  });
});

describe('date parsing', () => {
  it('reads Jira’s default format', () => {
    expect(parseJiraDate('12/Mar/26')?.day).toBe(toDayNum('2026-03-12'));
    expect(parseJiraDate('12/Mar/2026 3:04 PM')?.day).toBe(toDayNum('2026-03-12'));
  });

  it('reads ISO and long forms', () => {
    expect(parseJiraDate('2026-03-12')?.day).toBe(toDayNum('2026-03-12'));
    expect(parseJiraDate('2026-03-12T15:04:00.000+0000')?.day).toBe(toDayNum('2026-03-12'));
    expect(parseJiraDate('12 March 2026')?.day).toBe(toDayNum('2026-03-12'));
    expect(parseJiraDate('March 12, 2026')?.day).toBe(toDayNum('2026-03-12'));
  });

  it('honours the day-first setting only where the value is genuinely ambiguous', () => {
    expect(parseJiraDate('03/04/2026', true)?.day).toBe(toDayNum('2026-04-03'));
    expect(parseJiraDate('03/04/2026', false)?.day).toBe(toDayNum('2026-03-04'));
    expect(parseJiraDate('03/04/2026', true)?.ambiguous).toBe(true);

    // A day over 12 settles the order whatever the setting says.
    expect(parseJiraDate('25/04/2026', false)?.day).toBe(toDayNum('2026-04-25'));
    expect(parseJiraDate('25/04/2026', false)?.ambiguous).toBe(false);
  });

  it('reports rather than guesses an unreadable value', () => {
    expect(parseJiraDate('next Tuesday')).toBeNull();
    expect(parseJiraDate('')).toBeNull();
    expect(parseJiraDate('12/Foo/26')).toBeNull();
  });

  it('asks about ambiguity only when the file cannot settle it', () => {
    expect(needsDayFirstPrompt(['03/04/2026', '05/06/2026'])).toBe(true);
    // One unambiguous value proves the whole column's order.
    expect(needsDayFirstPrompt(['03/04/2026', '25/12/2026'])).toBe(false);
    expect(needsDayFirstPrompt(['12/Mar/26'])).toBe(false);
    expect(needsDayFirstPrompt([])).toBe(false);
  });
});

describe('importing', () => {
  const result = importJiraRows(parsed.rows, mapping, {
    ...DEFAULT_IMPORT_OPTIONS,
    pointsToDays: 1,
    defaultDurationDays: 3,
  });
  const taskOf = (key: string) => result.project.tasks.find((t) => t.id === key)!;

  it('imports every row that has a key', () => {
    expect(result.stats.rows).toBe(6);
    expect(result.project.tasks).toHaveLength(6);
  });

  it('nests epic children and subtasks', () => {
    expect(taskOf('GNT-2').parentId).toBe('GNT-1');
    expect(taskOf('GNT-3').parentId).toBe('GNT-1');
    // `Parent` wins over `Epic Link` when both are present.
    expect(taskOf('GNT-6').parentId).toBe('GNT-3');
    expect(taskOf('GNT-1').parentId).toBeNull();
  });

  it('turns blocks links into finish-to-start dependencies', () => {
    const links = result.project.dependencies.map((d) => `${d.predecessorId}→${d.successorId}`);
    expect(links).toContain('GNT-2→GNT-4');
    expect(links).toContain('GNT-3→GNT-5');
    for (const dep of result.project.dependencies) {
      expect(dep.type).toBe('FS');
      expect(dep.lagDays).toBe(0);
    }
  });

  it('expands a link onto the children of an epic rather than dropping it', () => {
    // GNT-2 blocks GNT-3, but GNT-3 has a subtask (GNT-6) and so is a summary row.
    // Blocking the epic means blocking the work inside it.
    const links = result.project.dependencies.map((d) => `${d.predecessorId}→${d.successorId}`);
    expect(links).not.toContain('GNT-2→GNT-3');
    expect(links).toContain('GNT-2→GNT-6');
    expect(
      result.warnings.some(
        (w) => w.kind === 'summary-successor-expanded' && w.message.includes('GNT-3'),
      ),
    ).toBe(true);
  });

  it('reports a link to an issue outside the export rather than dropping it silently', () => {
    const warning = result.warnings.find(
      (w) => w.kind === 'unknown-link-target' && w.message.includes('GNT-99'),
    );
    expect(warning).toBeDefined();
  });

  it('derives duration from two dates when both are present', () => {
    // 2 Mar to 6 Mar 2026 is Mon to Fri: five working days.
    expect(taskOf('GNT-2').durationDays).toBe(5);
    expect(result.notes.find((n) => n.taskId === 'GNT-2')?.durationSource).toBe('both-dates');
  });

  it('falls back to story points when there are no dates', () => {
    expect(taskOf('GNT-3').durationDays).toBe(8);
    expect(result.notes.find((n) => n.taskId === 'GNT-3')?.durationSource).toBe('story-points');
  });

  it('records how every duration was arrived at', () => {
    expect(result.notes).toHaveLength(6);
    for (const note of result.notes) {
      expect(note.durationSource).toBeTruthy();
    }
  });

  it('makes a milestone-typed issue a zero-duration marker', () => {
    expect(taskOf('GNT-5').durationDays).toBe(0);
    expect(schedule(result.project).tasks.get('GNT-5')!.kind).toBe('milestone');
  });

  it('pins imported start dates so the schedule respects them', () => {
    expect(taskOf('GNT-2').constraint).toEqual({ type: 'SNET', day: toDayNum('2026-03-02') });
    expect(schedule(result.project).tasks.get('GNT-2')!.start).toBe(toDayNum('2026-03-02'));
  });

  it('does not pin a summary task, whose dates are derived', () => {
    expect(taskOf('GNT-1').constraint).toBeUndefined();
  });

  it('starts the project on the earliest imported date', () => {
    expect(result.project.startDate).toBe('2026-03-02');
  });

  it('maps statuses and priorities onto Ganttor’s scheme', () => {
    expect(taskOf('GNT-2').status).toBe('done');
    expect(taskOf('GNT-3').status).toBe('on-track');
    expect(taskOf('GNT-4').status).toBe('not-started');
    expect(taskOf('GNT-6').status).toBe('delayed');
    expect(taskOf('GNT-3').priority).toBe('highest');
    expect(taskOf('GNT-4').priority).toBe('low');
  });

  it('treats a done issue as complete, the only progress a CSV carries', () => {
    expect(taskOf('GNT-2').percentComplete).toBe(100);
    expect(taskOf('GNT-3').percentComplete).toBe(0);
  });

  it('creates a resource per assignee and deduplicates them', () => {
    expect(result.project.resources.map((r) => r.name).sort()).toEqual([
      'Lena Brandt',
      'Priya Raman',
      'Tom Okafor',
    ]);
    // Priya is on two issues but is one resource.
    expect(taskOf('GNT-2').assigneeIds).toEqual(taskOf('GNT-4').assigneeIds);
  });

  it('uses the last sprint as the phase', () => {
    expect(taskOf('GNT-2').phase).toBe('Sprint 2');
    expect(taskOf('GNT-3').phase).toBe('Sprint 2');
  });

  it('produces a project that schedules without cycles or unsupported links', () => {
    const scheduled = schedule(result.project);
    expect(scheduled.cycles).toEqual([]);
    expect(scheduled.cyclicDepIds.size).toBe(0);
    expect(scheduled.unsupportedDepIds.size).toBe(0);
    expect(scheduled.tasks.size).toBe(6);
  });

  it('respects the points factor', () => {
    const doubled = importJiraRows(parsed.rows, mapping, {
      ...DEFAULT_IMPORT_OPTIONS,
      pointsToDays: 2,
    });
    expect(doubled.project.tasks.find((t) => t.id === 'GNT-3')!.durationDays).toBe(16);
  });
});

describe('importing awkward data', () => {
  it('skips a row with no key and says so', () => {
    const csv = 'Issue key,Summary\n,Nameless\nGNT-1,Real';
    const p = parseCsv(csv);
    const result = importJiraRows(p.rows, detectColumns(p.headers));
    expect(result.project.tasks).toHaveLength(1);
    expect(result.warnings.some((w) => w.kind === 'missing-key')).toBe(true);
  });

  it('keeps the first of a duplicated key', () => {
    const csv = 'Issue key,Summary\nGNT-1,First\nGNT-1,Second';
    const p = parseCsv(csv);
    const result = importJiraRows(p.rows, detectColumns(p.headers));
    expect(result.project.tasks).toHaveLength(1);
    expect(result.project.tasks[0]!.name).toBe('First');
    expect(result.warnings.some((w) => w.kind === 'duplicate-key')).toBe(true);
  });

  it('reports a parent that is not in the export and keeps the task', () => {
    const csv = 'Issue key,Summary,Parent\nGNT-1,Child,GNT-404';
    const p = parseCsv(csv);
    const result = importJiraRows(p.rows, detectColumns(p.headers));
    expect(result.project.tasks[0]!.parentId).toBeNull();
    expect(result.warnings.some((w) => w.kind === 'unknown-parent')).toBe(true);
  });

  it('falls back to the default duration when a due date precedes its start', () => {
    const csv = 'Issue key,Summary,Custom field (Start date),Due date\nGNT-1,Backwards,10/Mar/26,03/Mar/26';
    const p = parseCsv(csv);
    const result = importJiraRows(p.rows, detectColumns(p.headers), {
      ...DEFAULT_IMPORT_OPTIONS,
      defaultDurationDays: 4,
    });
    expect(result.project.tasks[0]!.durationDays).toBe(4);
    expect(result.warnings.some((w) => w.kind === 'end-before-start')).toBe(true);
  });

  it('back-calculates a start from a due date alone', () => {
    const csv = 'Issue key,Summary,Due date,Custom field (Story Points)\nGNT-1,Due only,13/Mar/26,';
    const p = parseCsv(csv);
    const result = importJiraRows(p.rows, detectColumns(p.headers), {
      ...DEFAULT_IMPORT_OPTIONS,
      defaultDurationDays: 3,
    });
    const task = result.project.tasks[0]!;
    expect(task.durationDays).toBe(3);
    // 13 Mar 2026 is a Friday, so three working days back starts on the Wednesday.
    expect(toISO(task.constraint!.day)).toBe('2026-03-11');
    expect(toISO(schedule(result.project).tasks.get('GNT-1')!.end)).toBe('2026-03-13');
  });

  it('imports an export with nothing but keys and summaries', () => {
    const csv = 'Issue key,Summary\nGNT-1,One\nGNT-2,Two';
    const p = parseCsv(csv);
    const result = importJiraRows(p.rows, detectColumns(p.headers));
    expect(result.project.tasks).toHaveLength(2);
    expect(result.project.dependencies).toEqual([]);
    expect(schedule(result.project).tasks.size).toBe(2);
  });
});
