/**
 * Full-bleed art band.
 *
 * The scroll choreography for the page's image sections: the photograph sits in
 * a 3D frame and the scrub timeline lifts it into place as the band crosses the
 * viewport — perspective tilt easing out to flat, scale settling, a slow
 * parallax drift. The copy column reveals on the same scroll position, so the
 * image and the text arrive as one movement rather than two.
 *
 * Resolved state (no JavaScript, reduced motion, or a crawler): the image at its
 * natural size and orientation, every line of copy visible. The stylesheet
 * describes that state; the timeline only ever removes the offset.
 */
import { useEnterAnimation, useScrubTimeline, animate, stagger } from "@/lib/motion";

export default function ArtBand({
  src,
  alt,
  kicker,
  title,
  lede,
  align = "left",
  testid,
  children,
}) {
  const scrub = useScrubTimeline((timeline) => {
    timeline.add(".band-media img", {
      rotateX: [7, 0],
      scale: [1.14, 1],
      translateY: ["-3%", "3%"],
      duration: 1000,
    });
  });

  const copy = useEnterAnimation((_scope, root) => {
    animate(root.querySelectorAll("[data-band-line]"), {
      opacity: [0, 1],
      translateY: [22, 0],
      duration: 720,
      delay: stagger(110),
      ease: "out(3)",
    });
  });

  return (
    <section className={`band band-${align}`} data-testid={testid} ref={scrub}>
      <div className="band-media">
        <img src={src} alt={alt} loading="lazy" decoding="async" />
        <span className="band-veil" aria-hidden="true" />
      </div>

      <div className="mk-container mk-container-wide band-inner">
        <div className="band-copy" ref={copy}>
          {kicker ? (
            <p className="mk-margin-label" data-band-line>
              {kicker}
            </p>
          ) : null}
          <h2 className="mk-display mk-band-title" data-band-line>
            {title}
          </h2>
          {lede ? (
            <p className="mk-lede mk-band-lede" data-band-line>
              {lede}
            </p>
          ) : null}
          {children}
        </div>
      </div>
    </section>
  );
}
