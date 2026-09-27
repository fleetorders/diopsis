import type { Page } from '@playwright/test';
import type { StabilizeOptions } from '../config.ts';

/** Storybook 7+ renders into `#storybook-root`; v6 used `#root`. */
export const RENDER_ROOTS = ['#storybook-root', '#root'] as const;

/** Markers that mean "this page is still loading" — waited out before capture. */
export const LOADING_SELECTORS = [
  '[aria-busy="true"]',
  '[data-diopsis-loading]',
  '[role="progressbar"]',
] as const;

/** `{base}/iframe.html?viewMode=story&id={storyId}` — the preview, without the manager UI. */
export function storyUrlFor(baseUrl: string, storyId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/iframe.html?viewMode=story&id=${encodeURIComponent(storyId)}`;
}

export class StoryRenderError extends Error {
  detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = 'StoryRenderError';
    this.detail = detail;
  }
}

/**
 * Everything that must be in place *before* the story navigates.
 *
 * The clock is fixed rather than masked: a mask hides content from review and still fails the
 * diff when its bounding box moves, so time is made deterministic instead (DECISIONS.md §3).
 * `page.clock` is a property, not a method.
 */
export async function preparePage(page: Page, options: StabilizeOptions): Promise<void> {
  if (options.freezeClock) {
    await page.clock.setFixedTime(new Date(options.freezeClock));
  }
  if (options.disableAnimations) {
    // Playwright's own `animations: 'disabled'` covers the capture itself; this additionally
    // keeps scroll anchoring and caret blink from moving between the wait and the shutter.
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          transition-delay: 0s !important;
          transition-duration: 0s !important;
          animation-delay: -0.0001s !important;
          animation-duration: 0s !important;
          animation-iteration-count: 1 !important;
          caret-color: transparent !important;
          scroll-behavior: auto !important;
        }
      `,
    }).catch(() => {
      // No document yet on a blank page; the same style is re-applied after navigation.
    });
  }
}

/**
 * How idleness is decided.
 *
 * Playwright's own `networkidle` waits for 500 ms of silence on every navigation, which on a
 * build served from the local disk is most of what a capture costs. The 500 ms exists to catch a
 * request that starts late — typically a fetch behind a short timer. So the page is watched
 * directly instead: requests in flight are counted, and so are timers of up to
 * `TIMER_HORIZON_MS` that page code has scheduled, because each of those may be about to start
 * one. Idle means neither is pending and nothing changed for `NETWORK_QUIET_MS`. A timer
 * scheduled from inside another timer's callback is not counted, so a ticking widget cannot hold
 * the wait open until the deadline.
 */
export const NETWORK_QUIET_MS = 50;
export const TIMER_HORIZON_MS = 500;

/** Installed before any page script runs; counts the short timers page code has pending. */
function timerProbe(horizon: number): void {
  const w = window as unknown as Record<string, unknown>;
  if (w['__diopsisTimers']) return;
  const pending = new Set<unknown>();
  let depth = 0;
  let lastFired = performance.now();
  const set = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  const patched = function (handler: unknown, delay?: number, ...args: unknown[]): unknown {
    if (typeof handler !== 'function') return set(handler as string, delay);
    const track = depth === 0 && (Number(delay) || 0) <= horizon;
    let id: unknown;
    const run = function (this: unknown): unknown {
      pending.delete(id);
      // Only a counted timer can be about to start a request the wait cares about; letting a
      // re-arming one refresh this would keep an animation-paced loop busy until the deadline.
      if (track) lastFired = performance.now();
      depth += 1;
      try {
        return (handler as (...a: unknown[]) => unknown).apply(this, args);
      } finally {
        depth -= 1;
      }
    };
    id = set(run, delay);
    if (track) pending.add(id);
    return id;
  };
  window.setTimeout = patched as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    pending.delete(id);
    clear(id);
  }) as typeof window.clearTimeout;
  w['__diopsisTimers'] = () => ({ pending: pending.size, sinceFired: performance.now() - lastFired });
}

export interface RequestTracker {
  /** Resolves once no request is in flight and none has started or ended for `quietMs`. */
  idle(quietMs: number, timeout: number): Promise<void>;
  dispose(): void;
}

/** Pages that already carry the timer probe; an init script added twice runs twice. */
const probed = new WeakSet<Page>();

/** Count the page's requests and short timers from before navigation, so none are missed. */
export async function trackRequests(page: Page): Promise<RequestTracker> {
  if (!probed.has(page)) {
    await page.addInitScript(timerProbe, TIMER_HORIZON_MS);
    probed.add(page);
  }
  let inflight = 0;
  let lastChange = Date.now();
  const started = (): void => {
    inflight += 1;
    lastChange = Date.now();
  };
  const settled = (): void => {
    inflight = Math.max(0, inflight - 1);
    lastChange = Date.now();
  };
  page.on('request', started);
  page.on('requestfinished', settled);
  page.on('requestfailed', settled);
  return {
    idle: async (quietMs, timeout) => {
      const giveUp = Date.now() + timeout;
      while (Date.now() < giveUp) {
        if (inflight === 0 && Date.now() - lastChange >= quietMs) {
          const timers = await page
            .evaluate(() => {
              const probe = (window as unknown as Record<string, unknown>)['__diopsisTimers'];
              return typeof probe === 'function'
                ? (probe as () => { pending: number; sinceFired: number })()
                : { pending: 0, sinceFired: Infinity };
            })
            .catch(() => ({ pending: 0, sinceFired: Infinity }));
          // A timer that just fired may have started a request the page has not reported yet.
          if (timers.pending === 0 && timers.sinceFired >= quietMs && inflight === 0) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    dispose: () => {
      page.off('request', started);
      page.off('requestfinished', settled);
      page.off('requestfailed', settled);
    },
  };
}

function deadline(timeout: number): { left(): number } {
  const start = Date.now();
  return { left: () => Math.max(0, timeout - (Date.now() - start)) };
}

/**
 * Wait until the story is actually painted.
 *
 * "The root exists" is not enough — the root exists while the skeleton is on screen, and a
 * capture taken there is a false baseline that only fails once the mock resolves faster.
 */
export async function stabilize(
  page: Page,
  options: StabilizeOptions,
  requests?: RequestTracker,
): Promise<void> {
  const budget = deadline(options.settleTimeout);

  const error = page.locator('#error-message');
  if (await error.isVisible().catch(() => false)) {
    throw new StoryRenderError('Story failed to render', (await error.innerText()).trim());
  }

  // The render root must have a laid-out child, not merely be present.
  await page.waitForFunction(
    (roots: readonly string[]) => {
      for (const selector of roots) {
        const root = document.querySelector(selector);
        if (!root) continue;
        for (const child of Array.from(root.children)) {
          const rect = child.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) return true;
        }
      }
      return false;
    },
    RENDER_ROOTS,
    { timeout: budget.left() || 1 },
  );

  if (options.waitForNetworkIdle) {
    // A story holding a long-poll open should slow a run, not fail it: both waits give up at
    // the deadline instead of throwing.
    if (requests) {
      await requests.idle(NETWORK_QUIET_MS, budget.left());
    } else {
      await page.waitForLoadState('networkidle', { timeout: budget.left() || 1 }).catch(() => undefined);
    }
  }

  if (options.waitForLoadingStates) {
    const selector = LOADING_SELECTORS.join(', ');
    await page
      .waitForFunction(
        (sel: string) =>
          Array.from(document.querySelectorAll(sel)).every((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width === 0 && rect.height === 0;
          }),
        selector,
        { timeout: budget.left() || 1 },
      )
      .catch(() => {
        // A permanently-busy widget is a story-authoring matter, not a run failure.
      });
  }

  if (options.waitForFonts) {
    await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
  }

  if (options.waitForImages) {
    await page
      .waitForFunction(
        () =>
          Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
        undefined,
        { timeout: budget.left() || 1 },
      )
      .catch(() => undefined);
  }

  // One more frame, so anything scheduled by the waits above has painted.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** Padding, in CSS pixels, added around a component's union box before clipping. */
export const COMPONENT_PADDING = 8;

/** The descendant walk stops here, so clipping cannot become a scan of a pathological page. */
const MAX_WALKED_ELEMENTS = 5000;

/** A clip rectangle in document coordinates, whole CSS pixels. */
export interface ComponentClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The box a component-scoped capture photographs: the union of the render root's children
 * that have a non-zero box, together with their descendants' — a child whose contents
 * overflow it, an absolutely positioned popover say, must not be cut short — padded on every
 * side and rounded outward to whole pixels. Undefined when nothing has a box, which is the
 * caller's signal to fall back to the page capture.
 *
 * Boxes are read in document coordinates, scroll offsets added, because a clip is applied to
 * a full-page screenshot: the coordinate system is the page, not the viewport.
 */
export async function componentClip(page: Page): Promise<ComponentClip | undefined> {
  return page.evaluate(
    ({ roots, padding, limit }: { roots: readonly string[]; padding: number; limit: number }) => {
      let root: Element | null = null;
      for (const selector of roots) {
        root = document.querySelector(selector);
        if (root) break;
      }
      if (!root) return undefined;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let any = false;
      let walked = 0;
      // A zero box contributes nothing to a union, and a display:none subtree reports zeros
      // at the origin — including it would drag the box to the page's corner.
      const include = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) return false;
        const x1 = rect.left + window.scrollX;
        const y1 = rect.top + window.scrollY;
        const x2 = x1 + rect.width;
        const y2 = y1 + rect.height;
        minX = Math.min(minX, x1);
        minY = Math.min(minY, y1);
        maxX = Math.max(maxX, x2);
        maxY = Math.max(maxY, y2);
        any = true;
        return true;
      };

      for (const child of Array.from(root.children)) {
        if (walked >= limit) break;
        if (!include(child)) continue;
        const stack: Element[] = [child];
        while (stack.length > 0 && walked < limit) {
          const element = stack.pop();
          if (!element) break;
          walked += 1;
          for (const descendant of Array.from(element.children)) {
            include(descendant);
            stack.push(descendant);
          }
        }
      }
      if (!any) return undefined;

      const x = Math.max(0, Math.floor(minX - padding));
      const y = Math.max(0, Math.floor(minY - padding));
      return {
        x,
        y,
        width: Math.ceil(maxX + padding) - x,
        height: Math.ceil(maxY + padding) - y,
      };
    },
    { roots: RENDER_ROOTS, padding: COMPONENT_PADDING, limit: MAX_WALKED_ELEMENTS },
  );
}

/**
 * Forget everything the previous story left behind.
 *
 * A page is reused across the captures one worker takes, because creating a browser context
 * per capture was a third of a run's time. Reuse is only sound if no story can see another's
 * state, so before each navigation the origin's storage is cleared through the browser itself —
 * local storage, IndexedDB, cache storage, service workers and cookies — and session storage,
 * which lives with the tab rather than the origin, is cleared in the page. In-memory state goes
 * with the document on navigation.
 */
export async function isolate(page: Page): Promise<void> {
  const current = page.url();
  if (!/^https?:/.test(current)) return;
  const origin = new URL(current).origin;
  await page.evaluate(() => {
    try {
      sessionStorage.clear();
    } catch {
      // A document that denies storage access has nothing to clear.
    }
  }).catch(() => undefined);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  await page.context().clearCookies();
}

/** Navigate to a story and leave the page ready to be photographed. */
export async function openStory(
  page: Page,
  url: string,
  options: StabilizeOptions,
): Promise<void> {
  await isolate(page);
  await preparePage(page, options);
  const requests = options.waitForNetworkIdle ? await trackRequests(page) : undefined;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Re-apply, because the pre-navigation style tag does not survive the document swap.
    await preparePage(page, options);
    await stabilize(page, options, requests);
  } finally {
    requests?.dispose();
  }
}
