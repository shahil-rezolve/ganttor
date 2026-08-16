/**
 * jsdom gaps that the renderer relies on.
 *
 * These are stubs, not behaviour. `ResizeObserver` exists in every browser Ganttor
 * targets but not in jsdom, and the chart only uses it to decide whether a label goes
 * inside or beside its bar — never to compute bar geometry. A no-op observer is
 * therefore faithful: layout still happens through the initial measurement.
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

// jsdom has no layout engine, so every element reports zero width. The chart reads
// `clientWidth` only for label placement; a realistic viewport keeps that decision
// meaningful in tests instead of pinning every label to the "before" fallback.
if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')?.get) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(): number {
      return 1600;
    },
  });
}

// Pointer capture is part of the drag gestures and is likewise absent from jsdom.
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
