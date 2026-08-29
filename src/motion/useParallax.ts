import { useScroll, useTransform, useReducedMotion } from 'framer-motion';

/**
 * Scroll-linked parallax for a page header. Drifts the element up slightly
 * and fades it as the page scrolls — creates depth between the header and
 * the content beneath. No-ops under prefers-reduced-motion.
 */
export function useParallax(distance = 48) {
  const reduced = useReducedMotion() ?? false;
  const { scrollY } = useScroll();
  const y = useTransform(scrollY, [0, 400], [0, reduced ? 0 : -distance]);
  const opacity = useTransform(scrollY, [0, 220], [1, reduced ? 1 : 0.5]);
  return { y, opacity };
}

/**
 * Returns a MotionValue that drifts *opposite* to scroll direction by `range`.
 * Used for ember layers behind the hero — they appear suspended, drifting up
 * as the page scrolls down. Watchtower-distinct touch.
 */
export function useReverseParallax(range = 40) {
  const reduced = useReducedMotion() ?? false;
  const { scrollY } = useScroll();
  return useTransform(scrollY, [0, 600], [0, reduced ? 0 : range]);
}
