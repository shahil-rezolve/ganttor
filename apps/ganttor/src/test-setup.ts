/**
 * jsdom gaps the app relies on. See the matching file in `packages/gantt` — same
 * reasoning: these are stubs for APIs the browser has and jsdom does not, never
 * substitutes for behaviour under test.
 */

import '@testing-library/dom';

if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: ResizeObserverStub,
  });
}

if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')?.get) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(): number {
      return 1600;
    },
  });
}

for (const method of ['setPointerCapture', 'releasePointerCapture'] as const) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, {
      configurable: true,
      writable: true,
      value(): void {},
    });
  }
}
if (!('hasPointerCapture' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'hasPointerCapture', {
    configurable: true,
    writable: true,
    value(): boolean {
      return false;
    },
  });
}
