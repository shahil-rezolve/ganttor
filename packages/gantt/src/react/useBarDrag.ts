/**
 * Pointer gestures on the chart: move a bar, resize either edge, or drag out a link.
 *
 * Three details make this feel like a real tool rather than a demo:
 *
 * 1. **Pointer capture.** The gesture is tracked on the element that received
 *    `pointerdown`, so it keeps following the cursor outside the bar, outside the
 *    chart, and past the window edge. No document-level listeners to leak.
 * 2. **Day quantisation, not pixel dragging.** The delta is converted to whole days
 *    immediately, so a drag lands on a date rather than somewhere between two.
 *    Sub-day movement produces no preview at all, which is what makes the bar feel
 *    like it snaps to the grid.
 * 3. **Preview separate from commit.** While dragging, only local preview state
 *    changes; the project is written once on release. The undo stack therefore gets one
 *    entry per gesture, not one per mouse move, and the scheduler is not re-run on
 *    every frame.
 */

import { useCallback, useRef, useState } from 'react';

import type { CompiledCalendar } from '../core/calendar.js';
import type { DayNum } from '../core/day.js';
import { editEnd, editStart, type TaskDates } from '../core/duration.js';
import type { TimeScale } from '../core/timescale.js';

export type DragMode = 'move' | 'resize-start' | 'resize-end' | 'link';

export interface DragPreview {
  taskId: string;
  mode: DragMode;
  /** Present for move and resize. */
  dates: TaskDates | null;
  /** Present for a link drag: the cursor position in canvas coordinates. */
  cursor: { x: number; y: number } | null;
  /** The task the cursor is currently over, for a link drag. */
  hoverTaskId: string | null;
}

export interface UseBarDragOptions {
  scale: TimeScale;
  calendar: CompiledCalendar;
  /** No gesture starts when true. */
  locked: boolean;
  /** Commit a move or resize. */
  onCommitDates: (taskId: string, dates: TaskDates) => void;
  /** Commit a new dependency. */
  onCommitLink: (predecessorId: string, successorId: string) => void;
}

export interface BarDragHandlers {
  preview: DragPreview | null;
  /** Attach to a bar, a resize handle, or a link dot. */
  onPointerDown: (
    event: React.PointerEvent<Element>,
    task: { id: string; start: DayNum; end: DayNum; durationDays: number },
    mode: DragMode,
  ) => void;
  /** Dates to render for a task, accounting for an in-flight gesture. */
  previewDatesFor: (taskId: string) => TaskDates | null;
}

export function useBarDrag(options: UseBarDragOptions): BarDragHandlers {
  const { scale, calendar, locked, onCommitDates, onCommitLink } = options;
  const [preview, setPreview] = useState<DragPreview | null>(null);

  // Held in a ref because pointer handlers must not depend on render-time state.
  const gesture = useRef<{
    taskId: string;
    mode: DragMode;
    startX: number;
    startY: number;
    original: TaskDates;
    latest: TaskDates | null;
    hoverTaskId: string | null;
  } | null>(null);

  const onPointerDown = useCallback(
    (
      event: React.PointerEvent<Element>,
      task: { id: string; start: DayNum; end: DayNum; durationDays: number },
      mode: DragMode,
    ) => {
      if (locked || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const element = event.currentTarget;
      element.setPointerCapture(event.pointerId);

      // `Element.addEventListener` is typed against `ElementEventMap`, which has no
      // pointer events — the richer maps live on `HTMLElement` and `SVGElement`, and a
      // bar can be either. These two helpers localize that to one place.
      const listen = (type: string, listener: (e: PointerEvent) => void): void =>
        element.addEventListener(type, listener as EventListener);
      const unlisten = (type: string, listener: (e: PointerEvent) => void): void =>
        element.removeEventListener(type, listener as EventListener);

      const original: TaskDates = {
        start: task.start,
        end: task.end,
        durationDays: task.durationDays,
      };

      gesture.current = {
        taskId: task.id,
        mode,
        startX: event.clientX,
        startY: event.clientY,
        original,
        latest: null,
        hoverTaskId: null,
      };

      setPreview({
        taskId: task.id,
        mode,
        dates: mode === 'link' ? null : original,
        cursor: null,
        hoverTaskId: null,
      });

      const handleMove = (moveEvent: PointerEvent) => {
        const current = gesture.current;
        if (!current) return;

        if (current.mode === 'link') {
          // Hit-test through the DOM so the drop target is whatever is under the
          // cursor, including a row in the left-hand grid.
          const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
          const hostRect = element.closest('.gantt__canvas')?.getBoundingClientRect();
          const hoverTaskId =
            under?.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null;

          current.hoverTaskId = hoverTaskId === current.taskId ? null : hoverTaskId;
          setPreview({
            taskId: current.taskId,
            mode: 'link',
            dates: null,
            cursor: hostRect
              ? { x: moveEvent.clientX - hostRect.left, y: moveEvent.clientY - hostRect.top }
              : null,
            hoverTaskId: current.hoverTaskId,
          });
          return;
        }

        // Quantise to whole days before doing anything else.
        const dayDelta = Math.round((moveEvent.clientX - current.startX) / scale.pxPerDay);
        if (dayDelta === 0) {
          current.latest = null;
          setPreview({
            taskId: current.taskId,
            mode: current.mode,
            dates: current.original,
            cursor: null,
            hoverTaskId: null,
          });
          return;
        }

        const next =
          current.mode === 'move'
            ? editStart(calendar, current.original, current.original.start + dayDelta)
            : current.mode === 'resize-end'
              ? editEnd(calendar, current.original, current.original.end + dayDelta)
              : resizeStart(calendar, current.original, dayDelta);

        current.latest = next;
        setPreview({
          taskId: current.taskId,
          mode: current.mode,
          dates: next,
          cursor: null,
          hoverTaskId: null,
        });
      };

      const detach = () => {
        unlisten('pointermove', handleMove);
        unlisten('pointerup', finish);
        unlisten('pointercancel', cancel);
      };

      const finish = (upEvent: PointerEvent) => {
        detach();
        if (element.hasPointerCapture(upEvent.pointerId)) {
          element.releasePointerCapture(upEvent.pointerId);
        }

        const current = gesture.current;
        gesture.current = null;
        setPreview(null);
        if (!current) return;

        if (current.mode === 'link') {
          if (current.hoverTaskId) onCommitLink(current.taskId, current.hoverTaskId);
          return;
        }
        // A gesture that never moved a whole day is not an edit.
        if (current.latest) onCommitDates(current.taskId, current.latest);
      };

      const cancel = (cancelEvent: PointerEvent) => {
        detach();
        if (element.hasPointerCapture(cancelEvent.pointerId)) {
          element.releasePointerCapture(cancelEvent.pointerId);
        }
        // A cancelled gesture commits nothing — the bar returns to its scheduled dates.
        gesture.current = null;
        setPreview(null);
      };

      listen('pointermove', handleMove);
      listen('pointerup', finish);
      listen('pointercancel', cancel);
    },
    [locked, scale.pxPerDay, calendar, onCommitDates, onCommitLink],
  );

  const previewDatesFor = useCallback(
    (taskId: string): TaskDates | null =>
      preview && preview.taskId === taskId ? preview.dates : null,
    [preview],
  );

  return { preview, onPointerDown, previewDatesFor };
}

/**
 * Dragging the left edge moves the start while holding the *finish*, so duration
 * absorbs the change. That is the opposite of `editStart`, which holds duration — both
 * are correct for their gesture, and conflating them is why resize handles in
 * hand-rolled Gantts often move the whole bar.
 */
function resizeStart(
  calendar: CompiledCalendar,
  original: TaskDates,
  dayDelta: number,
): TaskDates {
  if (original.durationDays === 0) {
    return editStart(calendar, original, original.start + dayDelta);
  }
  const requested = calendar.snapForward(original.start + dayDelta);
  if (requested > original.end) {
    return { start: original.end, end: original.end, durationDays: 1 };
  }
  return {
    start: requested,
    end: original.end,
    durationDays: calendar.workingDaysBetween(requested, original.end),
  };
}
