/**
 * The two-row timeline header.
 *
 * The rows come straight from `TimeScale.majorTicks()` / `minorTicks()`, which are
 * guaranteed to tile the axis exactly — so the header can never disagree with the grid
 * beneath it. At day zoom the fine row labels get centred and shrunk, because a column
 * that narrow holds `M2`, not `Mon 2 March`.
 */

import { memo } from 'react';

import type { CompiledCalendar } from '../core/calendar.js';
import type { TimeScale } from '../core/timescale.js';

export interface TimelineHeaderProps {
  scale: TimeScale;
  calendar: CompiledCalendar;
}

export const TimelineHeader = memo(function TimelineHeader({
  scale,
  calendar,
}: TimelineHeaderProps) {
  const major = scale.majorTicks();
  const minor = scale.minorTicks();
  const narrow = scale.unit === 'day';

  return (
    <div className="gantt__timeline-head" style={{ width: scale.totalWidth }}>
      <div className="gantt__tickrow gantt__tickrow--major">
        {major.map((tick) => (
          <div
            key={tick.day}
            className="gantt__tick"
            style={{ left: tick.x, width: tick.width }}
          >
            {tick.label}
          </div>
        ))}
      </div>
      <div className="gantt__tickrow">
        {minor.map((tick) => (
          <div
            key={tick.day}
            className={narrow ? 'gantt__tick gantt__tick--narrow' : 'gantt__tick'}
            style={{ left: tick.x, width: tick.width }}
            data-nonworking={narrow ? !calendar.isWorkingDay(tick.day) : undefined}
          >
            {tick.label}
          </div>
        ))}
      </div>
    </div>
  );
});
