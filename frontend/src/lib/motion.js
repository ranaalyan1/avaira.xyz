/**
 * Motion layer.
 *
 * Built on anime.js v4. Everything is:
 *   1. **Reduced-motion aware** — when `prefers-reduced-motion: reduce` is set,
 *      no animation is created at all. The stylesheet's default state is the
 *      *resolved* state (visible, in place), so the page simply appears.
 *   2. **SSR / test safe** — no window access at module scope, refs are guarded,
 *      and the static-render path used by the smoke tests never animates.
 *   3. **Observable-only where it matters** — reveals are driven by an
 *      IntersectionObserver so they fire exactly once, while scrubbed sections
 *      use anime's ScrollObserver (`sync: true`) so progress tracks the scroll
 *      position in both directions.
 */
import { useEffect, useRef, useState } from "react";
import {
  animate,
  createAnimatable,
  createScope,
  createTimeline,
  onScroll,
  stagger,
  utils,
} from "animejs";

/** True when the visitor asked the OS for less motion. */
export const prefersReducedMotion = () => {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

/** Fine pointers only (tilt and cursor-follow effects). */
const hasFinePointer = () => {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(pointer: fine)").matches;
};

const canObserve = () => typeof window !== "undefined" && typeof IntersectionObserver !== "undefined";

/** Easing shared by the entrance work: fast out, soft settle. */
export const EASE_OUT = "out(3)";
export const EASE_SOFT = "out(2)";

/**
 * Reveal every `[data-reveal]` inside the returned ref as it scrolls into view.
 *
 * Each target is observed on its own, so a long page reveals section by section
 * instead of firing everything at once, and a target is animated exactly once.
 * Targets that cross the threshold in the same callback are staggered, which is
 * what makes a row of cards arrive as a group.
 *
 * @returns {React.RefObject<HTMLElement>} attach to the page wrapper
 */
export function useReveal({
  selector = "[data-reveal]",
  distance = 24,
  duration = 760,
  step = 70,
  start = "0px 0px -12% 0px",
  threshold = 0.12,
} = {}) {
  const ref = useRef(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || !canObserve() || prefersReducedMotion()) return undefined;

    const targets = Array.from(root.querySelectorAll(selector));
    if (!targets.length) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const arriving = entries.filter((entry) => entry.isIntersecting);
        if (!arriving.length) return;
        arriving.forEach((entry) => observer.unobserve(entry.target));
        animate(
          arriving.map((entry) => entry.target),
          {
            opacity: [0, 1],
            translateY: [distance, 0],
            duration,
            delay: arriving.length > 1 ? stagger(step) : 0,
            ease: EASE_OUT,
          }
        );
      },
      { rootMargin: start, threshold }
    );

    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [selector, distance, duration, step, start, threshold]);

  return ref;
}

/**
 * Count a number up when it scrolls into view. The static render shows the
 * final value, so crawlers and no-JS visitors read the real figure.
 *
 * @returns {[React.RefObject<HTMLElement>, string]} ref and formatted display
 */
export function useCountUp(value, { duration = 1400, decimals = 0, prefix = "", suffix = "" } = {}) {
  const format = (n) => {
    const fixed = decimals > 0 ? Number(n).toFixed(decimals) : String(Math.round(Number(n)));
    const grouped = fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${prefix}${grouped}${suffix}`;
  };

  const ref = useRef(null);
  const [display, setDisplay] = useState(() => (Number.isFinite(Number(value)) ? format(value) : String(value)));

  useEffect(() => {
    const el = ref.current;
    if (!el || !Number.isFinite(Number(value))) return undefined;
    if (!canObserve() || prefersReducedMotion()) {
      setDisplay(format(value));
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const counter = { value: 0 };
        setDisplay(format(0));
        animate(counter, {
          value,
          duration,
          ease: "out(4)",
          onUpdate: () => setDisplay(format(counter.value)),
          onComplete: () => setDisplay(format(value)),
        });
      },
      { threshold: 0.4 }
    );

    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration, decimals, prefix, suffix]);

  return [ref, display];
}

/**
 * Pointer-driven 3D tilt with damped follow (anime's `createAnimatable`).
 * Disabled for touch devices and reduced-motion visitors.
 *
 * @param {{ max?: number, duration?: number }} options
 */
export function usePointerTilt({ max = 5, duration = 900, scale = 1.004 } = {}) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || !hasFinePointer()) return undefined;

    const tilt = createAnimatable(el, {
      rotateX: { duration, ease: "out(2)" },
      rotateY: { duration, ease: "out(2)" },
      translateZ: { duration, ease: "out(2)" },
    });

    const onMove = (event) => {
      const rect = el.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width;
      const py = (event.clientY - rect.top) / rect.height;
      tilt.rotateY(utils.lerp(-max, max, px));
      tilt.rotateX(utils.lerp(max, -max, py));
    };

    const onEnter = () => tilt.translateZ(scale > 1 ? 24 : 0);
    const onLeave = () => {
      tilt.rotateX(0);
      tilt.rotateY(0);
      tilt.translateZ(0);
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointerleave", onLeave);
      tilt.revert();
    };
  }, [max, duration, scale]);

  return ref;
}

/**
 * Scroll-scrubbed timeline.
 *
 * `build(timeline, utils)` receives an anime.js timeline that is linked to the
 * scroll position between the two thresholds, so it plays forwards and
 * backwards with the page. Progress is reported through `onProgress` (0 to 1)
 * so React state can follow the animation without driving it.
 *
 * Threshold syntax is "container target": enter `'start start'` begins when the
 * target's top reaches the viewport top, leave `'end end'` finishes when its
 * bottom reaches the viewport bottom. That is the full passage of the element.
 */
export function useScrubTimeline(build, { onProgress, smoothing = 0.18, deps = [] } = {}) {
  const ref = useRef(null);
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => {
    const root = ref.current;
    if (!root || prefersReducedMotion()) return undefined;

    let lastProgress = -1;
    const scope = createScope({ root }).add(() => {
      const timeline = createTimeline({
        defaults: { ease: "linear" },
        autoplay: onScroll({
          target: root,
          enter: "start start",
          leave: "end end",
          sync: true,
          syncSmooth: smoothing,
          onUpdate: (self) => {
            const p = utils.clamp(self.progress, 0, 1);
            if (Math.abs(p - lastProgress) < 0.002) return;
            lastProgress = p;
            progressRef.current?.(p);
          },
        }),
      });
      buildRef.current?.(timeline, utils);
    });

    return () => scope.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smoothing, ...deps]);

  return ref;
}

/**
 * Runs `play(scope)` once the element scrolls into view, using a scoped anime
 * context so every animation created inside is reverted on unmount.
 */
export function useEnterAnimation(play, { threshold = 0.25, rootMargin = "0px 0px -10% 0px" } = {}) {
  const ref = useRef(null);
  const playRef = useRef(play);
  playRef.current = play;

  useEffect(() => {
    const root = ref.current;
    if (!root || !canObserve() || prefersReducedMotion()) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const scope = createScope({ root }).add((self) => playRef.current?.(self, root));
        scopes.push(scope);
      },
      { threshold, rootMargin }
    );

    const scopes = [];
    observer.observe(root);
    return () => {
      observer.disconnect();
      scopes.forEach((scope) => scope.revert());
    };
  }, [threshold, rootMargin]);

  return ref;
}

export { animate, createTimeline, stagger, utils };
