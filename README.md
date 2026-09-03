# Ganttor

A Gantt chart tool for Jira tickets that behaves like project management software rather
than a timeline drawer: four dependency types with lag, automatic rescheduling, working-day
calendars, cycle detection, and a real critical path.

Built against [`CRITERIA.md`](./CRITERIA.md). Its own conclusion sets the priorities —
*"if your app correctly handles all four dependency types with automatic rescheduling and an
accurate critical path calculation, you've covered the two features that separate a 'real'
Gantt chart tool from a simple static timeline drawer"* — so the scheduling engine is a
pure, separately-tested module and everything else is a projection of its output.

```bash
pnpm install
pnpm dev        # http://localhost:5273
pnpm test
pnpm typecheck
pnpm build
```

It opens on a 25-task sample project; import your own via **Import Jira CSV**.

### Supabase setup

Projects live in one shared workspace: every signed-in user sees, opens, edits and deletes
the same set of projects. Three steps:

1. **Create the table.** Run [`supabase/schema.sql`](./supabase/schema.sql) in the Supabase
   SQL editor. It creates the `projects` table, its indexes, and the Row Level Security
   policies. RLS is not optional — the anon key ships in the browser bundle, so the
   policies are the only thing standing between a stranger and your data. They read
   `to authenticated … using (true)`: the `anon` role now has *no* policy at all, so an
   unauthenticated request reads nothing, and holding a session is the whole of the
   authorisation model.
2. **Create the accounts.** Dashboard → Authentication → Users → *Add user*, with
   **Auto Confirm User** ticked, once per person. There is no sign-up page in the app by
   design — and because any account is a full member of the workspace, leave email
   sign-ups disabled in Authentication → Providers → Email, or a stranger could
   self-register into it. Deleting a user does *not* delete their projects: `owner_id` is
   provenance only and falls to null, because their work is the team's.
3. **Point the app at it.** Copy `apps/ganttor/.env.example` to `apps/ganttor/.env.local`
   and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from
   Project Settings → Data API / API Keys.

**Without those variables the app still runs**, falling back to IndexedDB in the current
browser and skipping the login page. That is what the test suite uses, and it means a fresh
clone is never locked out of an app whose database does not exist yet. The toolbar says
*"this browser only"* whenever that fallback is active, so the two states are never
confusable.

---

## How it works

```
tools/Ganttor/
├── packages/gantt/            @ganttor/gantt — the reusable library
│   ├── src/core/              the scheduling engine. Pure TS: no React, no DOM, no I/O
│   │   ├── day.ts             integer day arithmetic (no Date, no timezones, no DST)
│   │   ├── calendar.ts        working weeks and holidays
│   │   ├── graph.ts           topological order + cycle recovery
│   │   ├── schedule.ts        forward pass, constraints, WBS rollups
│   │   ├── cpm.ts             backward pass, float, critical path
│   │   ├── duration.ts        the start/end/duration triangle
│   │   ├── timescale.ts       day/week/month/quarter → pixels
│   │   └── baseline.ts        frozen snapshots and variance
│   └── src/react/             DOM rows + SVG arrow overlay, no chart library
├── apps/ganttor/              the app: login, Jira CSV import, storage, panels
│   ├── src/lib/supabase.ts    the client, created only when credentials exist
│   └── src/store/
│       ├── persistence.ts     the document format + the local IndexedDB store
│       └── projectRepository.ts  one API over Supabase / IndexedDB
└── supabase/schema.sql        the table, its policies, and its trigger
```

The engine is importable on its own — `@ganttor/gantt/core` has no React dependency:

```ts
import { schedule, createDemoProject } from '@ganttor/gantt/core';

const result = schedule(createDemoProject());
result.tasks.get('t-cpm');   // { start, end, lateStart, totalFloat, isCritical, … }
result.criticalLinkIds;      // the highlighted chain
result.cycles;               // [['a','b','c','a']] if the data loops
```

### Three decisions worth knowing

**Tasks have no start or end date.** A `Task` carries a duration and optional constraints;
dates are *outputs* of `schedule()`, recomputed from the dependency graph on every change.
Storing dates on the task is how a Gantt tool drifts out of agreement with its own arrows.

**Dragging a bar writes a constraint, not a date.** The drop sets `SNET` ("start no earlier
than"). Without it, a task with no predecessors slides back to the project start on the next
recalculation — the bar springs back the moment you release it. With it, the task holds its
place *and* still yields to its predecessors, so a drag can't quietly break a dependency.

**All dates are integers.** A `DayNum` is a count of days since 1970-01-01, and every
calculation is integer addition. `Date` appears only at the boundaries. This removes
timezones, DST, and floating-point drift from the entire scheduling problem.

### Scheduling semantics

For a dependency from predecessor *p* to successor *s* with lag *L* working days:

| Type | Forward constraint | Backward (CPM) |
|------|--------------------|----------------|
| FS   | `s.start ≥ p.end + 1 + L`  | `p.lateFinish ≤ s.lateStart − 1 − L` |
| SS   | `s.start ≥ p.start + L`    | `p.lateStart ≤ s.lateStart − L`      |
| FF   | `s.end ≥ p.end + L`        | `p.lateFinish ≤ s.lateFinish − L`    |
| SF   | `s.end ≥ p.start + L`      | `p.lateStart ≤ s.lateFinish − L`     |

Negative lag is a lead (overlap). FF and SF bound the *finish*, so they are converted to an
implied start through the task's duration; the task then starts on the latest of the project
start, its own constraint, and every implied start. Lower bounds snap forward off
non-working days, upper bounds snap backward — getting that direction wrong is how
schedulers end up one day out around weekends.

Durations count **working days**: a 5-day task starting Monday ends Friday. Bars are drawn
on the **calendar** axis with non-working columns shaded, so a task spanning a weekend is
visibly wider than its duration. That's deliberate, and matches MS Project.

---

## CRITERIA compliance

### The verification table

Every row of the table in `CRITERIA.md`, and where it is proven.

| Criterion | Status | Implementation | Test |
|---|---|---|---|
| **Duration math** — change start date → end date auto-updates | ✅ | `core/duration.ts` | `core/schedule.test.ts` › *duration math* (6 tests: each field edited, weekend snapping, milestone, collapse-not-invert) |
| **Dependency propagation** — shift a predecessor → successors reschedule per type | ✅ | `core/schedule.ts` | `core/schedule.test.ts` › *dependency propagation* (11 tests: all 4 types × lag/lead/zero, chains, multiple predecessors, CRITERIA's own "delay A by 3 days" case) |
| **Critical path accuracy** — compare to manual CPM calculation | ✅ | `core/cpm.ts` | `core/cpm.test.ts` — a hand-computed fixture with **every** ES/EF/LS/LF/float asserted, *plus* a behavioural check over all 25 demo tasks: slip a task by exactly its float → finish holds; by one more day → finish moves exactly one day |
| **Circular dependency rejection** — A→B→C→A blocked or warned | ✅ | `core/graph.ts`, `findDependencyCycle` | `core/schedule.test.ts` › *circular dependency rejection* (7 tests) + `App.test.tsx` — the rejection names the tickets (`GNT-12 → GNT-13 → GNT-12`) and writes nothing |
| **Baseline integrity** — edit a task; the baseline bar does not move | ✅ | `core/baseline.ts` (deep-frozen) | `core/baseline.test.ts`, `App.test.tsx` › *baselines* |
| **Zoom consistency** — bar widths proportional across day/week/month | ✅ | `core/timescale.ts` | `core/timescale.test.ts` (30 tests, all 4 units), `GanttChart.test.tsx`, `App.test.tsx` |
| **Progress fill accuracy** — 60% renders as 60% of the bar | ✅ | `react/geometry.ts` + `.gantt__bar-remaining` | `react/geometry.test.ts` (0/25/60/99/100% + clamping), `GanttChart.test.tsx` asserts the rendered DOM width |
| **Milestone rendering** — zero-duration renders as a marker, not a bar | ✅ | `schedule.ts` `kind: 'milestone'`, SVG diamond | `core/schedule.test.ts` › *milestones*, `GanttChart.test.tsx` (asserts a 4-point polygon and no bar element) |

Zoom consistency is guaranteed *by construction* rather than by testing four code paths:
there is one geometry rule, `width = (end − start + 1) × pxPerDay`, and changing zoom
changes only `pxPerDay`. No bar geometry is special-cased per unit, so proportionality
cannot drift between views.

### Feature checklist

| Requirement | Status | Notes |
|---|---|---|
| Hierarchical task list, unique ids | ✅ | `core/wbs.ts`. Repairs malformed imports (missing or looping parents) rather than throwing |
| Start / end / duration interlock | ✅ | Explicit rules in `core/duration.ts`; every edit path routes through it |
| Task bars proportional to duration | ✅ | `core/timescale.ts` |
| Progress / percent-complete per task | ✅ | Summary rows derive it as a duration-weighted mean of children |
| Priority and status, colour-coded | ✅ | 5 statuses × 5 priorities |
| Assignees / resources | ✅ | Avatars in the grid, plus the workload view |
| All four dependency types + arrows | ✅ | Arrow attaches to the correct bar edges per type; SF genuinely points backwards |
| Auto-rescheduling with lag/lead | ✅ | Lag in working days; negative = lead |
| Circular dependency detection | ✅ | Refused at creation; imported loops are flagged, drawn dashed, and excluded — **the rest of the project still schedules** |
| Critical path calculation + highlight | ✅ | Real CPM. A link is critical only if both ends are critical *and* it is the binding constraint, so the highlight is a chain, not a scatter |
| Milestones as zero-duration markers | ✅ | Diamonds anchored on the date |
| Adjustable time scale | ✅ | Day / week / month / quarter |
| Today marker | ✅ | Vertical line + flag, hidden when off-axis |
| Baseline comparison | ✅ | Ghost bars, per-task variance, total slip, "what moved" table |
| Documented colour scheme | ✅ | `react/palette.ts` — colour is always a function of a field (status/priority/assignee/phase), never per-task. The legend is generated from the same tables, so it can't drift from the scheme. On the default status dimension: **Done is green, On track blue**, At risk amber, Delayed red, Not started grey. "Finished" is the green, so a glance at the chart reads as progress rather than as activity; the generic success green used elsewhere in the app (a favourable variance, a success notice) is its own `--gantt-ok` token |
| Readable density, 20–30 tasks | ✅ | 44px rows, 26px bars; labels too wide for their bar are placed *outside* it, never truncated. Tested at 30 concurrent tasks |
| Drag-and-drop editing, persisted | ✅ | Move, resize either edge, drag to link. Pointer capture, day-quantised, one undo entry per gesture. Debounced autosave to Supabase |
| Inline editing in the chart | ✅ | Name, duration, start, % and assignee are editable in the grid itself; each row adds, deletes, indents, outdents and moves up or down among its siblings. Derived cells (a summary's numbers, every finish date) stay read-only rather than accepting an edit the scheduler must overwrite |
| Resource workload view | ✅ | Per-person daily heatmap; over-capacity days flagged, worst offender first, click through to the clashing tasks |
| Comments per task | ✅ | Free-text notes in the detail panel |
| Update cadence | ✅ | Progress is editable inline and is not a scheduling input, so daily updates never move dates; weekly reflow is automatic |
| Access control: view-only vs edit | ⚠️ **Partial** | Supabase Auth gates the app. A project **opens view-only** and is switched to editable from the toolbar, which is per *document* and persists — so editing is opted into rather than the resting state. Past the gate, though, every signed-in user is a peer with full read/write/delete on every project, and the lock is per document, not per user. What is still missing is permission *levels* — see below |
| Real-time multi-user editing | ❌ **Not implemented** | There is a server and multiple users, but no live sync and no merge. A stale write is at least detected and refused rather than silently winning — see below |

**On the two unmet items.** There are multiple identities, but only one flat workspace:
users are created by hand in the Supabase dashboard, and every one of them is a peer with
full access to every project. Permission *levels* therefore still have nothing to grade —
they need a sharing model and a role column, neither of which exists here. The view-only
lock ships as the per-document form of access control, and it is a mode anyone can flip
rather than a grant anyone holds.

Real-time collaboration needs more than the backend that now exists. Two people editing the
same project both autosave the *whole* document, so what is implemented is a guard rather
than collaboration: each save carries the `updated_at` it last read, and the server refuses
an update whose row has moved. The stale writer is told, their autosave halts, and their
work is still on screen to export — nothing is silently discarded, but nothing is merged
either. Doing it properly means per-field or CRDT merge plus Supabase Realtime
subscriptions.

Nothing else in the checklist is stubbed or approximated.

**Attachments** are not implemented (comments are). Storing binaries in IndexedDB was judged
not to earn its complexity for an offline single-user tool.

---

## Jira import

**Jira → filter your issues → Export → Export Excel CSV (all fields)**, then drop the file
on the import wizard. It handles what real exports actually contain:

- **Repeated columns.** A multi-value field emits one column *per value*, all identically
  named — an issue blocking three others produces three `Outward issue link (Blocks)`
  columns. Every field maps to a list of column indices, never one.
- **Renamed custom fields.** Story points arrive as `Custom field (Story Points)`,
  `Story Points`, or `Story point estimate` depending on the instance.
- **Six date formats**, including Jira's default `12/Mar/26 3:04 PM`. Ambiguous
  `03/04/2026` values are detected, and you are asked *only* if nothing in the file settles
  the order — one `25/12/2026` proves the whole column is day-first.
- **A BOM**, ragged rows, duplicate keys, missing keys, links to issues outside the export,
  and due dates before their start date. Each is reported, never silently dropped.

Jira has no duration field, so one is inferred — and the preview step shows **every**
inference before you commit, with its source:

| Priority | Source |
|---|---|
| 1 | Start + due date → working days between them |
| 2 | Original estimate → seconds ÷ working day |
| 3 | Story points → × the points factor (configurable) |
| 4 | Due date only → back-calculated from the default duration |
| 5 | Nothing → the default duration |

`blocks` / `is blocked by` become finish-to-start with zero lag — the only reading Jira's
link model supports. Type and lag are then edited in Ganttor, which is the schema Jira
lacks. Subtasks and epic children become WBS nesting. A `blocks` link *onto an epic* is
expanded onto the epic's leaf children rather than dropped, mirroring how the scheduler
already treats a summary predecessor.

A task is a summary because it *has children*, not because Jira calls it an epic — an epic
with no imported children is ordinary schedulable work.

---

## Keyboard

| Key | Action |
|---|---|
| `⌘Z` / `⌘⇧Z` | Undo / redo |
| `←` `→` | Nudge the selected task by one day |
| `Delete` | Delete the selected task and its subtree |

---

## Tests

268 across the two packages. The engine suite is structured so that each `describe` block
corresponds to a row of the `CRITERIA.md` verification table.

```bash
pnpm test                                    # everything
pnpm --filter @ganttor/gantt test            # 191 — engine + renderer
pnpm --filter @ganttor/app test              # 77 — import, storage, end-to-end
pnpm --filter @ganttor/gantt test:watch
```

Expectations are written in working-day offsets from the project start (`wd(n)`) rather than
absolute dates, so they state what they mean instead of encoding a particular March.

The critical-path suite is worth singling out. Asserting hand-typed numbers only proves the
code agrees with whoever wrote both. So alongside the exact fixture, float is verified
*behaviourally* against its definition — for all 25 demo tasks, slipping a task by exactly
its float must leave the project finish untouched, and one day more must move it by exactly
one day. That pits the backward pass against the forward pass: two different algorithms
agreeing.

`App.test.tsx` drives the real app with the real store, the real engine, and the real
storage layer — no mocked scheduler — covering drag-to-reschedule propagation, cycle
rejection with named tickets, baseline integrity, zoom, the workload view, editing every
grid cell, and autosave surviving a reload.

It runs against the repository's IndexedDB backend, because vitest has no Supabase
credentials. That is the same code path a credential-less browser takes, not a test-only
mock: `projectRepository.ts` chooses its backend at call time, and both branches return
documents through the same `parseDocument` validation.

---

## Using the library elsewhere

`packages/gantt` is self-contained and depends on nothing but React (peer) for its renderer.
The core has no dependencies at all — no chart library, no date library.

```tsx
import { GanttChart, schedule, addDependency } from '@ganttor/gantt';
import '@ganttor/gantt/styles.css';

<GanttChart
  project={project}
  unit="week"
  onChangeDates={(taskId, dates) => setProject(pinTaskDates(project, taskId, dates))}
  onCreateLink={(from, to) => {
    const result = addDependency(project, { id: nextId, predecessorId: from, successorId: to });
    if (!result.ok) return showError(result.reason, result.cycle);  // cycle names the path
    setProject(result.value);
  }}
/>
```

Mutations are all pure `Project → Project`, which is why undo is just keeping previous
values — no inverse operations to write. Operations that can fail return a
`MutationResult` carrying the reason (and, for a cycle, the path) rather than throwing.

The chart is theme-aware: it follows `prefers-color-scheme` unless you set
`data-gantt-theme="light" | "dark"`. Every colour is a token defined once on `.gantt`, so no
rule hard-codes one.
