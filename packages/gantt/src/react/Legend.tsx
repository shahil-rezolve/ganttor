/**
 * The colour legend.
 *
 * Generated from the same tables `createColorScheme` reads, which is what makes
 * CRITERIA's *"consistent, documented colour scheme"* true rather than aspirational —
 * the documentation is the implementation.
 */

import type { ColorScheme } from './palette.js';

export interface LegendProps {
  colors: ColorScheme;
  /** Adds a critical-path swatch, since that styling is not part of the colour-by scheme. */
  showCriticalPath?: boolean;
}

export function Legend({ colors, showCriticalPath }: LegendProps) {
  return (
    <div className="ganttor-legend">
      <span className="ganttor-legend__title">{colors.dimension}</span>
      {colors.legend().map((entry) => (
        <span key={entry.key} className="ganttor-legend__item">
          <span className="ganttor-legend__swatch" style={{ background: entry.color }} />
          {entry.label}
        </span>
      ))}
      {showCriticalPath && (
        <span className="ganttor-legend__item">
          <span
            className="ganttor-legend__swatch ganttor-legend__swatch--outline"
            style={{ borderColor: 'var(--gantt-critical)' }}
          />
          Critical path
        </span>
      )}
    </div>
  );
}
