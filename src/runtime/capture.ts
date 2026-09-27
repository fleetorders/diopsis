import type { Locator, Page } from '@playwright/test';
import type { RawA11yViolation } from '../accessibility.ts';
import type { StabilizeOptions } from '../config.ts';
import type { InteractionState } from '../matrix.ts';

/** Storybook 7+ renders into `#storybook-root`; v6 used `#root`. */
export const RENDER_ROOTS = ['#storybook-root', '#root'] as const;

/** Markers that mean "this page is still loading" — waited out before capture. */
export const LOADING_SELECTORS = [
  '[aria-busy="true"]',
  '[data-diopsis-loading]',
  '[role="progressbar"]',
] as const;

/**
 * `{base}/iframe.html?viewMode=story&id={storyId}` — the preview, without the manager UI.
 * Globals, when a mode sets them, ride the URL as `&globals={key}:{value};…`, each key and
 * value percent-encoded and the pairs joined with `;` — the format the preview reads.
 */
export function storyUrlFor(
  baseUrl: string,
  storyId: string,
  globals?: Record<string, string>,
): string {
  const pairs = Object.entries(globals ?? {}).map(
    ([key, value]) => `${encodeURIComponent(key)}:${encodeURIComponent(value)}`,
  );
  return (
    `${baseUrl.replace(/\/$/, '')}/iframe.html?viewMode=story&id=${encodeURIComponent(storyId)}` +
    (pairs.length > 0 ? `&globals=${pairs.join(';')}` : '')
  );
}

export class StoryRenderError extends Error {
  detail: string;

  constructor(message: string, detail: string) {
    // The detail is the story's own error; it goes into the message because the message is
    // what reaches the summary and the terminal — a separate field never left this process.
    super(detail ? `${message}: ${detail}` : message);
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
 * the wait open until the deadline. A timer scheduled outside any timer callback still is — a
 * framework's scheduler runs its effects from a microtask or a message port, where the depth
 * guard cannot tell a re-arming tick from a fresh one — so re-arming that way is bounded by the
 * network instead: once no request has been in flight or settled for `TIMER_HORIZON_MS`
 * continuously, a pending timer whose callback source has already been scheduled before no
 * longer holds the wait. A callback scheduled for the first time still does, whenever it was
 * scheduled — a reveal or debounce set late in the quiet is a change the capture must show.
 */
export const NETWORK_QUIET_MS = 50;
export const TIMER_HORIZON_MS = 500;

/** Installed before any page script runs; counts the short timers page code has pending. */
function timerProbe(horizon: number): void {
  const w = window as unknown as Record<string, unknown>;
  if (w['__diopsisTimers']) return;
  // Pending counted timers, each with its callback's source: a source scheduled more than
  // once is a loop re-arming itself, however it gets back to setTimeout.
  const pending = new Map<unknown, string>();
  const scheduled = new Map<string, number>();
  let depth = 0;
  let lastFired = performance.now();
  let lastFreshFired = lastFired;
  const set = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  const patched = function (handler: unknown, delay?: number, ...args: unknown[]): unknown {
    if (typeof handler !== 'function') return set(handler as string, delay);
    const track = depth === 0 && (Number(delay) || 0) <= horizon;
    let id: unknown;
    const run = function (this: unknown): unknown {
      const source = pending.get(id);
      pending.delete(id);
      // Only a counted timer can be about to start a request the wait cares about; letting a
      // re-arming one refresh this would keep an animation-paced loop busy until the deadline.
      if (track) lastFired = performance.now();
      if (source !== undefined && (scheduled.get(source) ?? 0) < 2) lastFreshFired = lastFired;
      depth += 1;
      try {
        return (handler as (...a: unknown[]) => unknown).apply(this, args);
      } finally {
        depth -= 1;
      }
    };
    id = set(run, delay);
    if (track) {
      const source = String(handler);
      scheduled.set(source, (scheduled.get(source) ?? 0) + 1);
      pending.set(id, source);
    }
    return id;
  };
  window.setTimeout = patched as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    pending.delete(id);
    clear(id);
  }) as typeof window.clearTimeout;
  w['__diopsisTimers'] = () => {
    let fresh = 0;
    for (const source of pending.values()) if ((scheduled.get(source) ?? 0) < 2) fresh += 1;
    const now = performance.now();
    return { pending: pending.size, fresh, sinceFired: now - lastFired, sinceFresh: now - lastFreshFired };
  };
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
                ? (probe as () => Record<'pending' | 'fresh' | 'sinceFired' | 'sinceFresh', number>)()
                : { pending: 0, fresh: 0, sinceFired: Infinity, sinceFresh: Infinity };
            })
            .catch(() => ({ pending: 0, fresh: 0, sinceFired: Infinity, sinceFresh: Infinity }));
          // A whole horizon of network quiet with only re-armed timers pending is a loop the
          // depth guard cannot see (a framework schedules outside any timer callback), and
          // it no longer holds the wait; a timer scheduled for the first time still does.
          const quietHorizon = Date.now() - lastChange >= TIMER_HORIZON_MS;
          const holding = quietHorizon ? timers.fresh : timers.pending;
          // A timer that just fired may have started a request the page has not reported yet.
          const sinceFired = quietHorizon ? timers.sinceFresh : timers.sinceFired;
          if (holding === 0 && sinceFired >= quietMs && inflight === 0) {
            return;
          }
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
 * Render phases that mean the story, its play function included when it has one, is done.
 * Storybook 10 ends every render in `finished`, earlier versions in `completed`; `played` is
 * not final, because the story's cleanup hooks still run after it.
 */
const PLAY_DONE_PHASES = ['completed', 'finished', 'errored', 'aborted'] as const;

/**
 * Installed before any page script runs. Storybook assigns its event channel to a global, so a
 * property trap sees the channel the moment it exists and subscribes before the story renders.
 * A failed play function is reported as an event rather than a phase in current Storybook: the
 * `storyFinished` status is `error`. That status is also `error` when an addon report failed —
 * an accessibility check, say — which is not a broken story, so a finish explained by a failed
 * report is not counted.
 */
function playProbe(): void {
  const w = window as unknown as Record<string, unknown>;
  if (Object.getOwnPropertyDescriptor(w, '__STORYBOOK_ADDONS_CHANNEL__')) return;
  const state: { failed: boolean; detail: string } = { failed: false, detail: '' };
  w['__diopsisPlay'] = state;
  const fail = (detail: unknown): void => {
    state.failed = true;
    if (!state.detail && detail) state.detail = String(detail);
  };
  const messageOf = (value: unknown): string => {
    const first = Array.isArray(value) ? value[0] : value;
    if (first && typeof first === 'object' && 'message' in first) {
      return String((first as { message: unknown }).message);
    }
    return first === undefined ? '' : String(first);
  };
  let channel: unknown;
  Object.defineProperty(w, '__STORYBOOK_ADDONS_CHANNEL__', {
    configurable: true,
    get: () => channel,
    set: (next: unknown) => {
      channel = next;
      const on = (next as { on?: (event: string, fn: (payload: unknown) => void) => void })?.on;
      if (typeof on !== 'function') return;
      const listen = on.bind(next);
      listen('playFunctionThrewException', (error) => fail(messageOf(error)));
      listen('unhandledErrorsWhilePlaying', (errors) => fail(messageOf(errors)));
      listen('storyFinished', (payload) => {
        const finished = payload as { status?: string; reporters?: Array<{ status?: string }> };
        const reportFailed = (finished?.reporters ?? []).some((r) => r?.status === 'failed');
        if (finished?.status === 'error' && !reportFailed) fail('');
      });
    },
  });
}

/** Pages that already carry the play probe. */
const playProbed = new WeakSet<Page>();

/** Install the play probe before navigation, once per page. */
export async function probePlay(page: Page): Promise<void> {
  if (playProbed.has(page)) return;
  await page.addInitScript(playProbe);
  playProbed.add(page);
}

/**
 * What a failed play function says on the page, if anything: Storybook's error display names
 * the failure in `#error-message` and `#error-stack`; that text is the detail worth
 * reporting. When neither is showing, the phase itself is all the page knows.
 */
async function playFailureDetail(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const selector of ['#error-message', '#error-stack']) {
    const display = page.locator(selector);
    if (!(await display.isVisible().catch(() => false))) continue;
    const text = (await display.innerText().catch(() => '')).trim();
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : 'the story reported an errored render phase';
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

  if (options.waitForPlay) {
    // A play function runs after the story has rendered, so every wait above can pass while
    // an interaction is still being applied; a capture taken there photographs it half-done.
    // Storybook's preview exposes the render phase. A preview without one, an older
    // Storybook, skips the wait rather than paying for a phase that will never appear.
    const phaseTracked = await page
      .evaluate(() => {
        const preview = (window as unknown as Record<string, unknown>)['__STORYBOOK_PREVIEW__'] as
          | { currentRender?: { phase?: unknown } }
          | undefined;
        return typeof preview?.currentRender?.phase === 'string';
      })
      .catch(() => false);
    if (phaseTracked) {
      // Still playing at the deadline gives up like the other waits, not a run failure.
      const phase = await page
        .waitForFunction(
          (done: readonly string[]) => {
            const preview = (window as unknown as Record<string, unknown>)[
              '__STORYBOOK_PREVIEW__'
            ] as { currentRender?: { phase?: unknown } } | undefined;
            const phase = preview?.currentRender?.phase;
            return typeof phase === 'string' && done.includes(phase) ? phase : null;
          },
          PLAY_DONE_PHASES,
          { timeout: budget.left() || 1 },
        )
        .then((handle) => handle.jsonValue())
        .catch(() => undefined);
      const reported = await page
        .evaluate(() => (window as unknown as Record<string, unknown>)['__diopsisPlay'] as
          | { failed: boolean; detail: string }
          | undefined)
        .catch(() => undefined);
      if (phase === 'errored' || reported?.failed) {
        const shown = await playFailureDetail(page);
        const detail =
          reported?.detail && shown === 'the story reported an errored render phase'
            ? reported.detail
            : shown;
        throw new StoryRenderError('Story play function failed', detail);
      }
    }
  }

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
  await nextPaint(page);
}

/**
 * Two animation frames: enough for anything the page just scheduled — the last wait of a
 * capture, or a state the browser is still applying — to reach the screen.
 */
async function nextPaint(page: Page): Promise<void> {
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

/** The first element inside a render root that a state's selector names — it alone, never the manager UI around the root. */
async function stateTarget(page: Page, selector: string): Promise<Locator> {
  for (const root of RENDER_ROOTS) {
    const found = page.locator(root).locator(selector);
    if ((await found.count()) > 0) return found.first();
  }
  // An element without a box is as unusable for a state as a selector naming nothing: both
  // leave the tag pointing at nothing the camera can hold.
  throw new StoryRenderError('State target not found', selector);
}

/**
 * Hold a story's interaction state for the shutter — the pointer and keyboard states a play
 * function cannot still be holding when the screenshot is taken, which is why they are
 * applied after `openStory` rather than scripted into the story.
 *
 * `hover` moves the pointer onto the target; `focus` focuses it after pressing and releasing
 * Shift, because `:focus-visible` follows the browser's focus modality and an element focused
 * from a script shows that styling only once a key has gone down — Shift being the one no
 * story listens for; `active` presses the target's centre and leaves the button down, since
 * releasing it is what ends `:active` — the release is `releaseState`'s, after the assertion.
 */
export async function applyState(page: Page, state: InteractionState): Promise<void> {
  const target = await stateTarget(page, state.selector);
  if (state.action === 'hover') {
    await target.hover();
  } else if (state.action === 'focus') {
    await page.keyboard.press('Shift');
    await target.focus();
  } else {
    const box = await target.boundingBox();
    if (!box) throw new StoryRenderError('State target not found', state.selector);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }
  await nextPaint(page);
}

/**
 * Give back what a state held. The page is reused for the captures one worker takes, so a
 * button still down — or a pointer still parked over the element — would leak into the next
 * story's capture: the button goes up and the pointer returns to the corner it started
 * from. Focus and hover need nothing here; the next capture's navigation replaces the
 * document they lived in.
 */
export async function releaseState(page: Page): Promise<void> {
  await page.mouse.up().catch(() => undefined);
  await page.mouse.move(0, 0).catch(() => undefined);
}

/** Nodes kept per rule: enough to find every failing element, few enough to stay compact. */
const MAX_A11Y_NODES = 10;

/** axe names a node by a selector, or a chain of them through shadow roots and frames. */
function targetString(target: unknown): string {
  const parts = Array.isArray(target) ? target : [target];
  return parts.map((part) => (Array.isArray(part) ? part.join(' ') : String(part))).join(' >> ');
}

/** What the page-side audit hands back, before it is trimmed to the review's shape. */
interface RawAxeResult {
  violations: Array<{
    id: string;
    impact: string | null;
    help: string;
    helpUrl: string;
    nodes: Array<{ target: unknown }>;
  }>;
}

/**
 * Audit the story's render root and return the violations a review needs: the rule, its
 * impact, its help text, and where it failed. The library is the tested project's own
 * axe-core (DECISIONS.md D-041), injected as source because the page is served from a
 * static build with no way to import it; injected here rather than at navigation time
 * because the audit runs after the screenshot, so nothing it does can touch the pixels
 * the comparison just judged (DECISIONS.md D-042).
 */
export async function auditAccessibility(page: Page, axeSource: string): Promise<RawA11yViolation[]> {
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(() => {
    const axe = (window as unknown as { axe?: { run: (context: string) => Promise<unknown> } }).axe;
    if (!axe) throw new Error('axe-core was not injected');
    return axe.run('#storybook-root, #root');
  });
  const raw = results as RawAxeResult;
  return (raw.violations ?? []).map((violation) => ({
    id: violation.id,
    ...(violation.impact ? { impact: violation.impact } : {}),
    help: violation.help,
    helpUrl: violation.helpUrl,
    targets: violation.nodes.slice(0, MAX_A11Y_NODES).map((node) => targetString(node.target)),
  }));
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
  if (options.waitForPlay) await probePlay(page);
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
