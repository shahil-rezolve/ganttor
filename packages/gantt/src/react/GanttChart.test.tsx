/**
 * The renderer, asserted against real DOM.
 *
 * `geometry.test.ts` proves the numbers; this proves the numbers reach the screen —
 * that a 60% task really has a 40%-wide veil, that a milestone renders as a polygon
 * rather than a bar, that the today line lands on today's column, and that 30
 * concurrent tasks stay legible.
 *
 * `today` is passed explicitly everywhere so no assertion depends on the date the
 * suite happens to run.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { toDayNum } from '../core/day.js';
import { createTimeScale } from '../core/timescale.js';
import { compileCalendar } from '../core/calendar.js';
import { saveBaseline, updateTask } from '../core/project.js';
import { createBaseline } from '../core/baseline.js';
import { schedule } from '../core/schedule.js';
import type { Project, ScaleUnit } from '../index.js';
import { GanttChart } from './GanttChart.js';
import { DEFAULT_METRICS } from './geometry.js';
import { buildProject, KIT_START, workingDayIndexer } from '../fixtures/kit.js';
import { createDemoProject } from '../fixtures/demo.js';

const wd = workingDayIndexer(KIT_START);
const TODAY = wd(3);

const px = (value: string | undefined): number => Number.parseFloat(value ?? '0');

/**
 * The same scale the chart builds internally, for comparing rendered pixels.
 *
 * Mirrors `useGanttView`, including its extension of the axis to cover a baseline that
 * reaches outside the live schedule — a slipped task's ghost bar must stay on-axis.
 */
function scaleFor(project: Project, unit: ScaleUnit) {
  const result = schedule(project);
  let from = result.projectStart;
  let to = result.projectFinish;

  const baseline = project.baselines.find((b) => b.id === project.activeBaselineId);
  if (baseline) {
    for (const bar of Object.values(baseline.bars)) {
      if (bar.start < from) from = bar.start;
      if (bar.end > to) to = bar.end;
    }
  }

  return createTimeScale({
    unit,
    from,
    to,
    calendar: compileCalendar(project.calendar),
    padDays: 7,
  });
}

describe('bars', () => {
  const project = buildProject({
    tasks: [
      { id: 'A', dur: 5, pct: 60, name: 'Design the thing' },
      { id: 'B', dur: 3, name: 'Build the thing' },
    ],
    deps: [['A', 'B']],
  });

  it('renders one bar per task', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    expect(screen.getByTestId('bar-A')).toBeTruthy();
    expect(screen.getByTestId('bar-B')).toBeTruthy();
  });

  it('makes a five-day bar exactly five grid units wide', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    const scale = scaleFor(project, 'day');
    const bar = screen.getByTestId('bar-A');
    expect(px(bar.style.width)).toBeCloseTo(scale.pxPerDay * 5, 6);
  });

  it('positions a bar at its start date', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    const scale = scaleFor(project, 'day');
    const b = schedule(project).tasks.get('B')!;
    expect(px(screen.getByTestId('bar-B').style.left)).toBeCloseTo(scale.xOf(b.start), 6);
  });

  // CRITERIA: "Set task to 60% complete; bar fill visually reflects 60% of its length."
  it('veils exactly the unfinished 40% of a 60%-complete bar', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    const width = px(screen.getByTestId('bar-A').style.width);
    const remaining = px(screen.getByTestId('remaining-A').style.width);
    expect(remaining).toBeCloseTo(width * 0.4, 6);
    expect(width - remaining).toBeCloseTo(width * 0.6, 6);
  });

  it('shows no veil at 100% and a full veil at 0%', () => {
    const edges = buildProject({
      tasks: [
        { id: 'done', dur: 3, pct: 100 },
        { id: 'fresh', dur: 3, pct: 0 },
      ],
    });
    render(<GanttChart project={edges} unit="day" today={TODAY} />);
    expect(px(screen.getByTestId('remaining-done').style.width)).toBe(0);
    expect(px(screen.getByTestId('remaining-fresh').style.width)).toBeCloseTo(
      px(screen.getByTestId('bar-fresh').style.width),
      6,
    );
  });

  it('keeps bar widths proportional across every zoom level', () => {
    for (const unit of ['day', 'week', 'month', 'quarter'] as ScaleUnit[]) {
      const { unmount } = render(<GanttChart project={project} unit={unit} today={TODAY} />);
      const five = px(screen.getByTestId('bar-A').style.width);
      const three = px(screen.getByTestId('bar-B').style.width);
      expect(five / three, `ratio at ${unit} zoom`).toBeCloseTo(5 / 3, 6);
      unmount();
    }
  });
});

describe('milestones', () => {
  // CRITERIA: "Zero-duration task renders as a marker, not a bar."
  const project = buildProject({
    tasks: [
      { id: 'A', dur: 4 },
      { id: 'M', dur: 0, name: 'Signed off' },
    ],
    deps: [['A', 'M']],
  });

  it('renders a marker and no bar', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    expect(screen.getByTestId('milestone-M')).toBeTruthy();
    expect(screen.queryByTestId('bar-M')).toBeNull();
  });

  it('draws a four-point polygon rather than a rectangle', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    const polygon = screen.getByTestId('milestone-M').querySelector('polygon');
    expect(polygon).toBeTruthy();
    expect(polygon!.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(4);
  });

  it('centres the marker on its date', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    const scale = scaleFor(project, 'day');
    const day = schedule(project).tasks.get('M')!.start;
    const marker = screen.getByTestId('milestone-M');
    const centre = px(marker.style.left) + px(marker.style.width) / 2;
    expect(centre).toBeCloseTo(scale.centerOf(day), 0);
  });
});

describe('summary tasks', () => {
  const project = buildProject({
    tasks: [
      { id: 'P', dur: 0, name: 'Epic' },
      { id: 'K1', dur: 3, parent: 'P' },
      { id: 'K2', dur: 4, parent: 'P' },
    ],
    deps: [['K1', 'K2']],
  });

  it('renders a bracket spanning its children', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    const scale = scaleFor(project, 'day');
    const summary = screen.getByTestId('summary-P');
    const rolled = schedule(project).tasks.get('P')!;
    expect(px(summary.style.left)).toBeCloseTo(scale.xOf(rolled.start), 6);
    expect(px(summary.style.width)).toBeCloseTo(scale.widthOf(rolled.start, rolled.end), 6);
  });

  it('hides descendants when collapsed and restores them when expanded', () => {
    const collapsed = updateTask(project, 'P', { collapsed: true });
    const { unmount } = render(<GanttChart project={collapsed} unit="day" today={TODAY} />);
    expect(screen.queryByTestId('bar-K1')).toBeNull();
    expect(screen.getByTestId('summary-P')).toBeTruthy();
    unmount();

    render(<GanttChart project={project} unit="day" today={TODAY} />);
    expect(screen.getByTestId('bar-K1')).toBeTruthy();
  });

  it('offers an expander only on rows that have children', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    expect(screen.getByLabelText('Collapse Epic')).toBeTruthy();
    expect(screen.queryByLabelText(/Collapse K1/)).toBeNull();
  });
});

describe('today marker', () => {
  const project = buildProject({ tasks: [{ id: 'A', dur: 10 }] });

  it('sits on today’s column', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    const scale = scaleFor(project, 'day');
    expect(px(screen.getByTestId('gantt-today').style.left)).toBeCloseTo(scale.xOf(TODAY), 6);
  });

  it('is omitted when today is off the axis', () => {
    render(<GanttChart project={project} unit="day" today={toDayNum('2031-01-01')} />);
    expect(screen.queryByTestId('gantt-today')).toBeNull();
  });
});

describe('dependency arrows', () => {
  const project = buildProject({
    tasks: [
      { id: 'A', dur: 4 },
      { id: 'B', dur: 3 },
      { id: 'C', dur: 3 },
    ],
    deps: [
      ['A', 'B', 'FS'],
      ['A', 'C', 'SS'],
    ],
  });

  it('draws one arrow per dependency, tagged with its type', () => {
    const { container } = render(<GanttChart project={project} unit="day" today={TODAY} />);
    const groups = container.querySelectorAll('[data-dependency-id]');
    expect(groups).toHaveLength(2);
    expect(container.querySelector('[data-dependency-id="d1"]')!.getAttribute('data-type')).toBe('FS');
    expect(container.querySelector('[data-dependency-id="d2"]')!.getAttribute('data-type')).toBe('SS');
  });

  it('gives each arrow an arrowhead and a clickable hit area', () => {
    const { container } = render(
      <GanttChart project={project} unit="day" today={TODAY} onSelectDependency={() => {}} />,
    );
    const group = container.querySelector('[data-dependency-id="d1"]')!;
    expect(group.querySelector('polygon.gantt__arrow-head')).toBeTruthy();
    expect(group.querySelector('polyline.gantt__arrow-hit')).toBeTruthy();
  });

  it('marks the critical chain and leaves slack links unmarked', () => {
    const { container } = render(<GanttChart project={project} unit="day" today={TODAY} />);
    const result = schedule(project);
    for (const dep of project.dependencies) {
      const line = container.querySelector(`[data-dependency-id="${dep.id}"] .gantt__arrow`)!;
      expect(line.getAttribute('data-critical')).toBe(
        result.criticalLinkIds.has(dep.id) ? 'true' : null,
      );
    }
  });

  it('flags a cyclic link instead of dropping the arrow', () => {
    const looped: Project = {
      ...project,
      dependencies: [
        ...project.dependencies,
        { id: 'd3', predecessorId: 'B', successorId: 'A', type: 'FS', lagDays: 0 },
      ],
    };
    const { container } = render(<GanttChart project={looped} unit="day" today={TODAY} />);
    const cyclic = container.querySelectorAll('.gantt__arrow[data-cyclic="true"]');
    expect(cyclic).toHaveLength(1);
  });
});

describe('critical path styling', () => {
  const project = buildProject({
    tasks: [
      { id: 'A', dur: 5 },
      { id: 'slack', dur: 1 },
      { id: 'B', dur: 3 },
    ],
    deps: [['A', 'B']],
  });

  it('marks critical bars and not the ones with float', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    expect(screen.getByTestId('bar-A').dataset.critical).toBe('true');
    expect(screen.getByTestId('bar-B').dataset.critical).toBe('true');
    expect(screen.getByTestId('bar-slack').dataset.critical).toBeUndefined();
  });

  it('drops the marking when the critical path is switched off', () => {
    const off: Project = { ...project, settings: { ...project.settings, showCriticalPath: false } };
    render(<GanttChart project={off} unit="day" today={TODAY} />);
    expect(screen.getByTestId('bar-A').dataset.critical).toBeUndefined();
  });
});

describe('baseline comparison', () => {
  const project = buildProject({ tasks: [{ id: 'A', dur: 4 }] });
  const withBaseline = saveBaseline(
    project,
    createBaseline({
      id: 'b1',
      name: 'Original',
      savedAt: '2026-03-02T00:00:00.000Z',
      result: schedule(project),
    }),
  );

  it('draws the ghost bar where the task was promised', () => {
    const slipped = updateTask(withBaseline, 'A', { constraint: { type: 'SNET', day: wd(4) } });
    render(<GanttChart project={slipped} unit="day" today={TODAY} />);

    const scale = scaleFor(slipped, 'day');
    const ghost = screen.getByTestId('baseline-A');
    // The ghost stays at the original day 0 while the live bar has moved to day 4.
    expect(px(ghost.style.left)).toBeCloseTo(scale.xOf(wd(0)), 6);
    expect(px(screen.getByTestId('bar-A').style.left)).toBeCloseTo(scale.xOf(wd(4)), 6);
  });

  it('draws nothing when the baseline overlay is off', () => {
    const hidden: Project = {
      ...withBaseline,
      settings: { ...withBaseline.settings, showBaseline: false },
    };
    render(<GanttChart project={hidden} unit="day" today={TODAY} />);
    expect(screen.queryByTestId('baseline-A')).toBeNull();
  });
});

describe('readable density', () => {
  // CRITERIA: "at default zoom, task labels should not overlap or truncate illegibly
  // for at least 20–30 concurrent tasks."
  const project = buildProject({
    tasks: Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      dur: 1 + (i % 4),
      name: `Concurrent workstream number ${i + 1}`,
    })),
  });

  it('renders all thirty rows', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    for (let i = 0; i < 30; i++) expect(screen.getByTestId(`bar-t${i}`)).toBeTruthy();
  });

  it('gives every row its own vertical band, so no two labels overlap', () => {
    render(<GanttChart project={project} unit="day" today={TODAY} />);
    const tops = Array.from({ length: 30 }, (_, i) =>
      px(screen.getByTestId(`bar-t${i}`).style.top),
    );
    const unique = new Set(tops);
    expect(unique.size).toBe(30);

    const sorted = [...tops].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      // Consecutive rows are exactly one row apart, and a row is taller than a bar.
      expect(sorted[i]! - sorted[i - 1]!).toBeCloseTo(DEFAULT_METRICS.rowHeight, 6);
    }
    expect(DEFAULT_METRICS.rowHeight).toBeGreaterThan(DEFAULT_METRICS.barHeight);
  });

  it('places a label outside its bar rather than clipping it', () => {
    const { container } = render(<GanttChart project={project} unit="day" today={TODAY} />);
    // A one-day bar cannot hold a 30-character name at any sane zoom, so every label
    // here should sit beside its bar — and an outside label is never width-capped.
    const labels = [...container.querySelectorAll<HTMLElement>('.gantt__bar-label')];
    expect(labels).toHaveLength(30);
    for (const label of labels) {
      expect(label.dataset.placement).not.toBe('inside');
      expect(label.style.maxWidth).toBe('');
    }
  });
});

describe('the bundled demo project', () => {
  const demo = createDemoProject();

  it('renders every visible row, arrows, and a critical path', () => {
    const { container } = render(<GanttChart project={demo} unit="week" today={TODAY} />);
    const result = schedule(demo);

    const bars = container.querySelectorAll('.gantt__bar');
    const milestones = container.querySelectorAll('.gantt__milestone');
    const summaries = container.querySelectorAll('.gantt__summary-bar');
    expect(bars.length + milestones.length + summaries.length).toBe(result.order.length);

    expect(container.querySelectorAll('[data-dependency-id]')).toHaveLength(
      demo.dependencies.length,
    );
    expect(container.querySelectorAll('.gantt__arrow[data-critical="true"]').length).toBeGreaterThan(0);
  });

  it('shades non-working days at day zoom', () => {
    const { container } = render(<GanttChart project={demo} unit="day" today={TODAY} />);
    expect(container.querySelectorAll('.gantt__col[data-nonworking="true"]').length).toBeGreaterThan(10);
  });
});

describe('view-only lock', () => {
  const project = buildProject({ tasks: [{ id: 'A', dur: 3 }] });
  const locked: Project = { ...project, settings: { ...project.settings, locked: true } };

  it('marks bars as locked and removes the edit affordances', () => {
    const { container } = render(
      <GanttChart project={locked} unit="day" today={TODAY} onChangeDates={() => {}} onCreateLink={() => {}} />,
    );
    expect(screen.getByTestId('bar-A').dataset.locked).toBe('true');
    expect(container.querySelector('.gantt__handle')).toBeNull();
    expect(screen.queryByTestId('linkdot-A')).toBeNull();
  });

  it('offers those affordances when unlocked', () => {
    const { container } = render(
      <GanttChart project={project} unit="day" today={TODAY} onChangeDates={() => {}} onCreateLink={() => {}} />,
    );
    expect(container.querySelectorAll('.gantt__handle')).toHaveLength(2);
    expect(screen.getByTestId('linkdot-A')).toBeTruthy();
  });
});

describe('empty state', () => {
  it('says what to do next instead of rendering an empty grid', () => {
    const empty = buildProject({ tasks: [] });
    render(<GanttChart project={empty} unit="day" today={TODAY} />);
    expect(screen.getByText(/import a jira csv/i)).toBeTruthy();
  });
});
