import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, letting later utilities win over earlier conflicting ones.
 *
 * Only ever combines *utilities*. A `.ganttor-*` or `.gantt__*` class must never be
 * passed through here alongside utilities that touch the same property — see the
 * cascade-layer note at the top of `styles.css` for why that combination silently
 * does nothing.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
