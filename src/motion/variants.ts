import type { Variants, Transition } from 'framer-motion';

/**
 * Shared framer-motion presets for Watchtower.
 *
 * The easing curve matches the one already used in src/auth/LoginPage.tsx,
 * so heroes inside the app feel like the same product as the landing.
 *
 * Page transitions are a fade + horizontal slide rather than a fade + rise,
 * so moving between operations views reads as lateral navigation instead of
 * as a fresh page dropping in.
 */

export const EASE_OUT: [number, number, number, number] = [0.215, 0.61, 0.355, 1];

/** Page-level enter/exit for route transitions — fade + slide-from-right. */
export const pageVariants: Variants = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0, transition: { duration: 0.42, ease: EASE_OUT } },
  exit:    { opacity: 0, x: -16, transition: { duration: 0.2, ease: 'easeIn' } },
};

/** Container that staggers its direct children. */
export const heroStagger: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.08, delayChildren: 0.04 } },
};

/** Child entrance to pair with heroStagger — slight rise + fade. */
export const heroItem: Variants = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.46, ease: EASE_OUT } },
};

/** Soft hover lift for cards. Spread onto a motion element's whileHover. */
export const hoverLift = { y: -4, transition: { type: 'spring', stiffness: 380, damping: 26 } as Transition };
export const tapPress = { scale: 0.985 };
