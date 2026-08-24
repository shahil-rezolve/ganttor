/**
 * Where portalled overlays go.
 *
 * The chart's palette is declared on `.gantt` (`gantt.css`), not on `:root`, so anything
 * Radix portals to `document.body` lands *outside* the token scope: `var(--gantt-bg)`
 * resolves to nothing there and the surface renders transparent over the chart. It reads
 * as a component bug and is really a scoping one.
 *
 * So overlays go into a host that lives inside the themed subtree instead. The fallback
 * to `body` keeps a component usable when it is rendered without the app shell around it
 * — unstyled, but not broken.
 */
export const OVERLAY_HOST_ID = 'ganttor-overlays';

export function overlayContainer(): HTMLElement | null {
  return document.getElementById(OVERLAY_HOST_ID);
}
