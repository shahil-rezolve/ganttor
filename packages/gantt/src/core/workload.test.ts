/**
 * CRITERIA: *"A way to see if a person is over-allocated (assigned overlapping tasks
 * exceeding capacity)."*
 */

import { describe, expect, it } from 'vitest';

import { compileCalendar, DEFAULT_CALENDAR } from './calendar.js';
import { schedule } from './schedule.js';
import { computeWorkload } from './workload.js';
import { buildProject } from '../fixtures/kit.js';

const cal = compileCalendar(DEFAULT_CALENDAR);

const project = buildProject({
  tasks: [
    { id: 'A', dur: 5, assignees: ['p'] },
    { id: 'B', dur: 5, assignees: ['p'] },
    { id: 'C', dur: 3, assignees: ['q'] },
    { id: 'D', dur: 2, assignees: ['q'] },
    { id: 'unassigned', dur: 4 },
  ],
  // C then D, so q is never double-booked.
  deps: [['C', 'D']],
  resources: [
    { id: 'p', name: 'Priya' },
    { id: 'q', name: 'Quinn' },
  ],
});

const workload = computeWorkload(project, schedule(project), cal);
const loadFor = (id: string) => workload.resources.find((r) => r.resourceId === id)!;

describe('resource workload', () => {
  it('flags the person on two concurrent tasks', () => {
    const priya = loadFor('p');
    expect(priya.peakLoad).toBe(2);
    expect(priya.overAllocatedDays).toBe(5);
    expect(priya.days.every((day) => day.load === 2)).toBe(true);
  });

  it('leaves the person whose tasks are sequenced alone', () => {
    const quinn = loadFor('q');
    expect(quinn.peakLoad).toBe(1);
    expect(quinn.overAllocatedDays).toBe(0);
    expect(quinn.totalAssignedDays).toBe(5);
  });

  it('lists the culprits for an over-allocated day', () => {
    const day = loadFor('p').days[0]!;
    expect(day.taskIds.sort()).toEqual(['A', 'B']);
  });

  it('counts only working days', () => {
    for (const resource of workload.resources) {
      for (const day of resource.days) expect(cal.isWorkingDay(day.day)).toBe(true);
    }
  });

  it('ignores unassigned work', () => {
    expect(workload.resources).toHaveLength(2);
  });

  it('sorts the worst offender first', () => {
    expect(workload.resources[0]!.resourceId).toBe('p');
  });

  it('does not double-book a summary task against its children', () => {
    const nested = buildProject({
      tasks: [
        { id: 'P', dur: 0, assignees: ['p'] },
        { id: 'K', dur: 3, parent: 'P', assignees: ['p'] },
      ],
      resources: [{ id: 'p' }],
    });
    const rolled = computeWorkload(nested, schedule(nested), cal);
    expect(rolled.resources[0]!.peakLoad).toBe(1);
    expect(rolled.resources[0]!.overAllocatedDays).toBe(0);
  });

  it('reports assignees with no resource record instead of dropping them', () => {
    const ghosted = buildProject({
      tasks: [{ id: 'A', dur: 2, assignees: ['nobody'] }],
      resources: [],
    });
    const result = computeWorkload(ghosted, schedule(ghosted), cal);
    expect(result.unknownAssigneeIds).toEqual(['nobody']);
    expect(result.resources[0]!.name).toBe('nobody');
  });

  it('respects a capacity above one', () => {
    const team = buildProject({
      tasks: [
        { id: 'A', dur: 3, assignees: ['squad'] },
        { id: 'B', dur: 3, assignees: ['squad'] },
      ],
      resources: [{ id: 'squad', capacity: 2 }],
    });
    const result = computeWorkload(team, schedule(team), cal);
    expect(result.resources[0]!.peakLoad).toBe(2);
    expect(result.resources[0]!.overAllocatedDays).toBe(0);
  });
});
