import { Window } from "happy-dom";

// Create a DOM-like environment.
const win = new Window({ url: "http://localhost/" });

// Cast through `any` to avoid type mismatches between happy-dom types and
// TypeScript's built-in DOM lib types.
const g = globalThis as any;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
g.localStorage = win.localStorage;
g.sessionStorage = win.sessionStorage;
g.HTMLElement = win.HTMLElement;
g.Node = win.Node;
g.Event = win.Event;
g.KeyboardEvent = win.KeyboardEvent;
g.MouseEvent = win.MouseEvent;
g.CustomEvent = win.CustomEvent;
g.getComputedStyle = win.getComputedStyle.bind(win);

// requestAnimationFrame is used by React/RTL/user-event in some flows.
g.requestAnimationFrame ??= (cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0);
g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);

// Some components rely on matchMedia (theme/system).
g.matchMedia ??= (query: string) => {
  const mql = {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  } satisfies MediaQueryList;
  return mql;
};

// Some components (like AppLayout) use ResizeObserver.
g.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};


