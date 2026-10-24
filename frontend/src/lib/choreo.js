import { useEffect } from "react";
import { prefersReducedMotion } from "@/lib/motion";

/* ══════════════════════════════════════════════════════════════════════════
   GSAP choreography for the immersive landing.

   One entrance timeline for the hero: the wordmark and nav settle first,
   the display headline rises, the supporting copy and actions follow, the
   HUD corners draw in last. Everything is choreographed ONCE on mount.

   Rules:
    - gsap + ScrollTrigger are imported dynamically, so they code-split
      out of the entry bundle and jest static renders never evaluate them.
    - under prefers-reduced-motion nothing runs; the stylesheet's default
      state is the resolved state, so the page simply appears.
    - a failed dynamic import degrades to the same resolved state.

   Anti-pattern: driving per-frame scroll values through GSAP tweens into
   React state. Scrubbed values (the 3D separation) live in refs.
   ══════════════════════════════════════════════════════════════════════════ */

export function useHeroChoreo(rootRef) {
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (prefersReducedMotion()) return undefined;
    let ctx;
    let disposed = false;
    Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([{ gsap }, { ScrollTrigger }]) => {
      if (disposed || !rootRef.current) return;
      gsap.registerPlugin(ScrollTrigger);
      ctx = gsap.context(() => {
        const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
        tl.fromTo(
          ".imm-nav",
          { y: -18, autoAlpha: 0 },
          { y: 0, autoAlpha: 1, duration: 0.7 },
          0.1
        )
          .fromTo(
            ".imm-hero .imm-label",
            { y: 16, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 0.6 },
            0.25
          )
          .fromTo(
            ".imm-display",
            { y: 60, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 0.9 },
            0.35
          )
          .fromTo(
            ".imm-lead",
            { y: 24, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 0.7 },
            0.55
          )
          .fromTo(
            ".imm-hero-copy .imm-btn",
            { y: 16, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 0.6, stagger: 0.08 },
            0.7
          )
          .fromTo(
            ".imm-hud p",
            { x: -12, autoAlpha: 0 },
            { x: 0, autoAlpha: 1, duration: 0.5, stagger: 0.1 },
            0.8
          )
          .fromTo(
            [".imm-corner", ".imm-scrollhint"],
            { autoAlpha: 0 },
            { autoAlpha: 1, duration: 0.8 },
            1.1
          );
      }, rootRef);
    }).catch(() => { /* no gsap: the resolved state is already visible */ });
    return () => {
      disposed = true;
      if (ctx) ctx.revert();
    };
  }, [rootRef]);
}
