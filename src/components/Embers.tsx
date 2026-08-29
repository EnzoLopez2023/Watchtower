import { motion, useReducedMotion } from 'framer-motion';
import type { MotionValue } from 'framer-motion';
import { useThemeMode } from '../context/ThemeContext';

/**
 * Slow-drifting embers that live behind a PageHero. Toned-down version of
 * the landing page's `.hl-ember` pattern — fewer dots, lower peak opacity,
 * longer duration. Reads as ambient warmth, not as fireworks.
 *
 * Renders nothing under prefers-reduced-motion.
 */

const EMBERS = [
  { left: '14%', top: '28%', delay: 0,   dur: 22 },
  { left: '74%', top: '18%', delay: 4,   dur: 26 },
  { left: '50%', top: '62%', delay: 8.5, dur: 20 },
];

interface EmbersProps {
  /** Optional translateY MotionValue (e.g. from useReverseParallax) */
  yOffset?: MotionValue<number> | number;
}

export default function Embers({ yOffset }: EmbersProps) {
  const reduced = useReducedMotion();
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';

  if (reduced) return null;

  // Champagne sparks — gold in both modes carries the warmth so the cool
  // pewter dark canvas still feels inviting. Light reads softer; dark glows.
  const peakOpacity = isDark ? 0.36 : 0.24;
  const color = isDark ? 'rgba(220, 184, 122, 1)' : 'rgba(200, 165, 105, 1)';

  return (
    <motion.div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'visible',
        y: yOffset,
      }}
    >
      {EMBERS.map((e, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0 }}
          animate={{
            opacity: [0, peakOpacity, 0],
            y: [0, -32, -64],
            x: [0, i % 2 === 0 ? 18 : -16, 0],
          }}
          transition={{
            duration: e.dur,
            delay: e.delay,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
          style={{
            position: 'absolute',
            left: e.left,
            top: e.top,
            width: 6,
            height: 6,
            borderRadius: '50%',
            backgroundColor: color,
            boxShadow: `0 0 12px ${color}`,
            willChange: 'transform, opacity',
          }}
        />
      ))}
    </motion.div>
  );
}
