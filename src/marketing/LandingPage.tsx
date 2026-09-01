/**
 * The Watchtower marketing / sign-in landing page.
 *
 * Shown to every unauthenticated visitor in place of a bare login card. It
 * carries Watchtower's own identity — the warm "Hearth" palette, drifting
 * embers and a scroll-linked parallax — and every product shot on it is an
 * accurate reproduction of a real screen (see ./mockups.tsx).
 *
 * Rendered by src/app/RequireAuth.tsx, which sits above the router, so this
 * file uses in-page hash anchors rather than <Link>. The single call to
 * action starts the same MSAL redirect the old login card did.
 *
 * Entrances are a CSS opacity/transform transition gated by an
 * IntersectionObserver with a hard timeout fallback, so content is never left
 * invisible if the observer never fires (a page first painted in a background
 * tab, say). Framer-motion is used only for the decorative scroll parallax,
 * which is a no-op when it cannot run.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import {
  ArrowDownwardRounded as ArrowDownIcon,
  LoginRounded as LoginIcon,
} from '@mui/icons-material';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import type { MotionValue } from 'framer-motion';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../auth/msalConfig';
import { useThemeMode } from '../context/ThemeContext';
import { tokens } from '../theme/tokens';
import { withAlpha } from '../theme/contrast';
import { iosGlass } from '../theme/ios';
import Embers from '../components/Embers';
import { ErrorState } from '../components/StateBlocks';
import WatchtowerBrand from '../components/WatchtowerBrand';
import {
  GlanceMock,
  NetworkMock,
  PowerMock,
  ProtectMock,
  StatusMock,
  TopologyMock,
} from './mockups';

const MAXW = 1160;
const EASE = 'cubic-bezier(0.215, 0.61, 0.355, 1)';

// ── Scroll parallax ─────────────────────────────────────────────────────────

/**
 * Drift an element by `range` px across the page's scroll. Positive `range`
 * lags the page (moves down as you scroll down); negative leads it. A no-op
 * under prefers-reduced-motion, and harmless if framer cannot run — the value
 * simply stays at 0.
 */
function useDrift(range: number): MotionValue<number> {
  const reduced = useReducedMotion() ?? false;
  const { scrollY } = useScroll();
  return useTransform(scrollY, [0, 2400], [0, reduced ? 0 : range]);
}

// ── Reveal-on-scroll ────────────────────────────────────────────────────────

function Reveal({
  children,
  delay = 0,
  y = 20,
  sx,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  sx?: object;
}) {
  const reduced = useReducedMotion() ?? false;
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    // Guarantee: content is shown even if the observer never fires.
    const t = window.setTimeout(() => setShown(true), 1200);
    return () => {
      io.disconnect();
      window.clearTimeout(t);
    };
  }, [reduced]);

  return (
    <Box
      ref={ref}
      sx={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : `translateY(${y}px)`,
        transition: reduced
          ? 'none'
          : `opacity 620ms ${EASE} ${delay}ms, transform 620ms ${EASE} ${delay}ms`,
        willChange: 'opacity, transform',
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

// ── Small building blocks ───────────────────────────────────────────────────

function Logo() {
  return (
    <WatchtowerBrand
      iconSize={26}
      textSx={{
        fontFamily: 'var(--hearth-heading)',
        fontWeight: 800,
        fontSize: '1.05rem',
        letterSpacing: '-0.01em',
        color: 'inherit',
      }}
    />
  );
}

function Eyebrow({ text, color }: { text: string; color: string }) {
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
      <Box
        aria-hidden
        sx={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          bgcolor: color,
          boxShadow: `0 0 8px ${withAlpha(color, 0.7)}`,
        }}
      />
      <Typography
        sx={{
          fontSize: '0.68rem',
          fontWeight: 800,
          letterSpacing: '0.24em',
          textTransform: 'uppercase',
          color,
        }}
      >
        {text}
      </Typography>
    </Box>
  );
}

/** Headline with one phrase lifted into the italic accent treatment. */
function Headline({
  text,
  accent,
  accentColor,
  ink,
  size = 'clamp(2.1rem, 1.4rem + 3.2vw, 3.5rem)',
}: {
  text: string;
  accent?: string;
  accentColor: string;
  ink: string;
  size?: string;
}) {
  const parts: { s: string; a: boolean }[] =
    accent && text.includes(accent)
      ? (() => {
          const i = text.indexOf(accent);
          const out: { s: string; a: boolean }[] = [];
          if (i > 0) out.push({ s: text.slice(0, i), a: false });
          out.push({ s: accent, a: true });
          const tail = text.slice(i + accent.length);
          if (tail) out.push({ s: tail, a: false });
          return out;
        })()
      : [{ s: text, a: false }];
  return (
    <Typography
      component="h1"
      sx={{
        fontFamily: 'var(--hearth-heading)',
        fontSize: size,
        fontWeight: 700,
        lineHeight: 1.08,
        letterSpacing: '-0.025em',
        color: ink,
        m: 0,
      }}
    >
      {parts.map((p, i) =>
        p.a ? (
          <Box
            key={i}
            component="em"
            sx={{
              fontStyle: 'italic',
              color: accentColor,
              textShadow: `0 0 24px ${withAlpha(accentColor, 0.28)}`,
            }}
          >
            {p.s}
          </Box>
        ) : (
          <span key={i}>{p.s}</span>
        ),
      )}
    </Typography>
  );
}

// ── Sections ────────────────────────────────────────────────────────────────

interface Ctx {
  isDark: boolean;
  t: ReturnType<typeof tokens>;
  accent: string;
  onSignIn: () => void;
  busy: boolean;
}

function TopNav({ t, isDark, onSignIn, busy }: Ctx) {
  return (
    <Box
      component="header"
      sx={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 20,
        ...iosGlass(t, isDark),
        border: 'none',
        borderBottom: `1px solid ${withAlpha(t.line, 0.6)}`,
        borderRadius: 0,
      }}
    >
      <Box
        sx={{
          maxWidth: MAXW,
          mx: 'auto',
          px: { xs: 2, md: 4 },
          height: 62,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          color: t.ink,
        }}
      >
        <Logo />
        <Button
          onClick={onSignIn}
          disabled={busy}
          variant="contained"
          size="small"
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : null}
          sx={{ px: 2 }}
        >
          {busy ? 'Opening…' : 'Sign in'}
        </Button>
      </Box>
    </Box>
  );
}

function Hero({ t, isDark, accent, onSignIn, busy, error }: Ctx & { error: string | null }) {
  const mockDrift = useDrift(-70);
  const backDrift = useDrift(48);
  const emberDrift = useDrift(-40);

  return (
    <Box
      component="section"
      sx={{
        position: 'relative',
        overflow: 'hidden',
        pt: { xs: '120px', md: '176px' },
        pb: { xs: 10, md: 16 },
      }}
    >
      {/* Ambient background: grid, radial blooms, drifting embers */}
      <Box aria-hidden sx={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}>
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `linear-gradient(${withAlpha(t.line, 0.5)} 1px, transparent 1px), linear-gradient(90deg, ${withAlpha(
              t.line,
              0.5,
            )} 1px, transparent 1px)`,
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse 90% 70% at 50% 18%, #000 25%, transparent 78%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 90% 70% at 50% 18%, #000 25%, transparent 78%)',
          }}
        />
        <Box
          sx={{
            position: 'absolute',
            top: -160,
            left: '6%',
            width: 460,
            height: 460,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${withAlpha(accent, isDark ? 0.22 : 0.16)} 0%, transparent 70%)`,
            filter: 'blur(60px)',
          }}
        />
        <Box
          sx={{
            position: 'absolute',
            top: -80,
            right: '2%',
            width: 400,
            height: 400,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${withAlpha(t.champagne, isDark ? 0.16 : 0.12)} 0%, transparent 70%)`,
            filter: 'blur(60px)',
          }}
        />
        <motion.div style={{ position: 'absolute', inset: 0, y: emberDrift }}>
          <Embers />
        </motion.div>
      </Box>

      <Box
        sx={{
          position: 'relative',
          zIndex: 1,
          maxWidth: MAXW,
          mx: 'auto',
          px: { xs: 2, md: 4 },
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1.05fr 0.95fr' },
          gap: { xs: 6, md: 5 },
          alignItems: 'center',
        }}
      >
        <Box>
          <Reveal delay={0}>
            <Eyebrow text="Infrastructure operations" color={accent} />
          </Reveal>
          <Reveal delay={70}>
            <Headline
              text="The whole stack, watched from one tower."
              accent="one tower."
              accentColor={accent}
              ink={t.ink}
            />
          </Reveal>
          <Reveal delay={130}>
            <Box
              sx={{
                mt: 2,
                width: 72,
                height: 2,
                borderRadius: 1,
                background: `linear-gradient(90deg, ${accent} 0%, transparent 100%)`,
              }}
            />
          </Reveal>
          <Reveal delay={180}>
            <Typography
              sx={{
                mt: 2.5,
                fontSize: { xs: '1rem', md: '1.08rem' },
                lineHeight: 1.65,
                color: t.inkSoft,
                maxWidth: 540,
              }}
            >
              Watchtower pulls Azure, UniFi, UPS power, Synology storage and Protect cameras into
              one operations console — and the status page you read is the exact verdict the alert
              engine fired on.
            </Typography>
          </Reveal>
          <Reveal delay={240}>
            <Box sx={{ mt: 4, display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}>
              <Button
                onClick={onSignIn}
                disabled={busy}
                variant="contained"
                size="large"
                startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <LoginIcon />}
                sx={{ px: 3, py: 1.2 }}
              >
                {busy ? 'Opening sign-in…' : 'Sign in with Microsoft'}
              </Button>
              <Button
                component="a"
                href="#figures"
                size="large"
                endIcon={<ArrowDownIcon />}
                sx={{ px: 2.5, py: 1.2, color: t.inkSoft }}
              >
                See what&rsquo;s inside
              </Button>
            </Box>
          </Reveal>
          <Reveal delay={300}>
            <Typography sx={{ mt: 2.5, fontSize: '0.82rem', color: t.muted, maxWidth: 460 }}>
              Access to every view is decided by the role Watchtower holds for you — not your email
              address.
            </Typography>
          </Reveal>
          {error && (
            <Box sx={{ mt: 3, maxWidth: 460 }}>
              <ErrorState title="Sign-in failed" detail={error} onRetry={onSignIn} retryLabel="Retry" />
            </Box>
          )}
        </Box>

        {/* Product shot stack with parallax */}
        <Box sx={{ position: 'relative', minHeight: { xs: 340, md: 420 } }}>
          <Box
            sx={{
              position: 'absolute',
              right: { xs: '-6%', md: '-13%' },
              bottom: { xs: -30, md: -66 },
              width: { xs: '72%', md: '66%' },
              opacity: 0.72,
              filter: 'saturate(0.9)',
            }}
          >
            <motion.div style={{ y: backDrift }}>
              <Reveal delay={220} y={28}>
                <PowerMock t={t} isDark={isDark} />
              </Reveal>
            </motion.div>
          </Box>
          <Box sx={{ position: 'relative', zIndex: 2, width: { xs: '100%', md: '96%' } }}>
            <motion.div style={{ y: mockDrift }}>
              <Reveal delay={120} y={32}>
                <StatusMock t={t} isDark={isDark} />
              </Reveal>
            </motion.div>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function StatBand({ t, isDark, accent }: Ctx) {
  const stats: { n: string; label: string }[] = [
    { n: '12', label: 'subsystems on one page' },
    { n: '5', label: 'on-site agents streaming in' },
    { n: '30s', label: 'status refresh, always live' },
    { n: '0', label: 'trust assumed — every view role-gated' },
  ];
  return (
    <Box
      component="section"
      sx={{
        borderTop: `1px solid ${t.line}`,
        borderBottom: `1px solid ${t.line}`,
        background: withAlpha(t.ink, isDark ? 0.03 : 0.015),
      }}
    >
      <Box
        sx={{
          maxWidth: MAXW,
          mx: 'auto',
          px: { xs: 2, md: 4 },
          py: { xs: 4, md: 5 },
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' },
          gap: { xs: 3, md: 2 },
        }}
      >
        {stats.map((s, i) => (
          <Reveal key={s.label} delay={i * 70} y={14}>
            <Typography
              sx={{
                fontFamily: 'var(--hearth-heading)',
                fontSize: 'clamp(1.8rem, 1.3rem + 1.6vw, 2.4rem)',
                fontWeight: 800,
                lineHeight: 1,
                letterSpacing: '-0.02em',
                color: accent,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {s.n}
            </Typography>
            <Typography sx={{ mt: 0.75, fontSize: '0.82rem', color: t.inkSoft, lineHeight: 1.45 }}>
              {s.label}
            </Typography>
          </Reveal>
        ))}
      </Box>
    </Box>
  );
}

function Figure({
  t,
  accent,
  index,
  kicker,
  head,
  body,
  flip,
  children,
}: Ctx & {
  index: string;
  kicker: string;
  head: string;
  body: ReactNode;
  flip?: boolean;
  children: ReactNode;
}) {
  const drift = useDrift(flip ? 40 : -40);
  return (
    <Box
      component="section"
      sx={{
        maxWidth: MAXW,
        mx: 'auto',
        px: { xs: 2, md: 4 },
        py: { xs: 8, md: 13 },
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
        gap: { xs: 5, md: 8 },
        alignItems: 'center',
      }}
    >
      <Reveal sx={{ order: { xs: 1, md: flip ? 2 : 1 } }}>
        <Typography
          sx={{
            fontFamily: 'var(--hearth-heading)',
            fontSize: '0.8rem',
            fontWeight: 800,
            letterSpacing: '0.14em',
            color: t.muted,
          }}
        >
          FIG. {index}
        </Typography>
        <Typography
          sx={{
            mt: 1,
            fontSize: '0.66rem',
            fontWeight: 800,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: accent,
          }}
        >
          {kicker}
        </Typography>
        <Typography
          component="h2"
          sx={{
            mt: 1.5,
            fontFamily: 'var(--hearth-heading)',
            fontSize: 'clamp(1.5rem, 1.1rem + 1.8vw, 2.1rem)',
            fontWeight: 700,
            lineHeight: 1.15,
            letterSpacing: '-0.02em',
            color: t.ink,
          }}
        >
          {head}
        </Typography>
        <Typography sx={{ mt: 2, fontSize: '0.98rem', lineHeight: 1.65, color: t.inkSoft, maxWidth: 460 }}>
          {body}
        </Typography>
      </Reveal>
      <Reveal delay={90} y={24} sx={{ order: { xs: 2, md: flip ? 1 : 2 } }}>
        <motion.div style={{ y: drift }}>{children}</motion.div>
      </Reveal>
    </Box>
  );
}

function CtaBand({ t, isDark, accent, onSignIn, busy }: Ctx) {
  return (
    <Box
      component="section"
      sx={{
        position: 'relative',
        overflow: 'hidden',
        borderTop: `1px solid ${t.line}`,
        background: withAlpha(accent, isDark ? 0.08 : 0.06),
      }}
    >
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(ellipse 60% 120% at 50% 0%, ${withAlpha(accent, 0.18)} 0%, transparent 70%)`,
        }}
      />
      <Box
        sx={{
          position: 'relative',
          maxWidth: MAXW,
          mx: 'auto',
          px: { xs: 2, md: 4 },
          py: { xs: 9, md: 14 },
          textAlign: 'center',
        }}
      >
        <Reveal>
          <Typography
            component="h2"
            sx={{
              fontFamily: 'var(--hearth-heading)',
              fontSize: 'clamp(1.8rem, 1.3rem + 2.4vw, 2.8rem)',
              fontWeight: 700,
              letterSpacing: '-0.025em',
              lineHeight: 1.12,
              color: t.ink,
            }}
          >
            Sign in and take the tower.
          </Typography>
          <Typography sx={{ mt: 2, fontSize: '1rem', color: t.inkSoft, maxWidth: 520, mx: 'auto' }}>
            One organisation account opens every panel you have a role for. Nothing to install,
            nothing to configure.
          </Typography>
          <Button
            onClick={onSignIn}
            disabled={busy}
            variant="contained"
            size="large"
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <LoginIcon />}
            sx={{ mt: 4, px: 3.5, py: 1.3 }}
          >
            {busy ? 'Opening sign-in…' : 'Sign in with Microsoft'}
          </Button>
          <Typography sx={{ mt: 2, fontSize: '0.78rem', color: t.muted }}>
            Microsoft Entra ID · your organisation account
          </Typography>
        </Reveal>
      </Box>
    </Box>
  );
}

function Footer({ t }: Ctx) {
  return (
    <Box component="footer" sx={{ borderTop: `1px solid ${t.line}` }}>
      <Box
        sx={{
          maxWidth: MAXW,
          mx: 'auto',
          px: { xs: 2, md: 4 },
          py: 5,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 2,
          alignItems: 'center',
          justifyContent: 'space-between',
          color: t.muted,
        }}
      >
        <Box sx={{ color: t.inkSoft }}>
          <Logo />
        </Box>
        <Typography sx={{ fontSize: '0.8rem' }}>
          Infrastructure operations · role-gated · read-only by default
        </Typography>
      </Box>
    </Box>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const { instance } = useMsal();
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokens(isDark);
  const accent = isDark ? t.rustLight : t.rust;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const onSignIn = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setBusy(true);
    setError(null);
    instance.loginRedirect(loginRequest).catch((caught: unknown) => {
      startedRef.current = false;
      setBusy(false);
      setError(caught instanceof Error ? caught.message : 'Sign-in could not be started.');
    });
  }, [instance]);

  const ctx: Ctx = { isDark, t, accent, onSignIn, busy };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        color: t.ink,
        background: isDark
          ? `linear-gradient(180deg, ${t.bg} 0%, ${t.surface} 100%)`
          : `linear-gradient(180deg, ${t.paper} 0%, ${t.bg} 60%, ${t.surface} 100%)`,
        '& a': { textDecoration: 'none' },
      }}
    >
      <TopNav {...ctx} />
      <Hero {...ctx} error={error} />
      <StatBand {...ctx} />

      <Box id="figures" sx={{ scrollMarginTop: '80px' }}>
        <Figure
          {...ctx}
          index="01"
          kicker="Single source of truth"
          head="The status page can't disagree with the alert."
          body="Every verdict here is the same object the alert engine pushed from. If Watchtower shows a warning on the dashboard, the notification said warning too — there is no second severity rule to drift out of step."
        >
          <StatusMock t={t} isDark={isDark} />
        </Figure>

        <Figure
          {...ctx}
          index="02"
          flip
          kicker="One console, every layer"
          head="Cloud, network, power and storage — side by side."
          body="Azure spend and web-app health, UniFi WAN and clients, UPS battery and runtime, Protect cameras. The panels you would otherwise keep in five browser tabs, refreshed by the on-site agents."
        >
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
            <GlanceMock t={t} isDark={isDark} />
            <NetworkMock t={t} isDark={isDark} />
            <PowerMock t={t} isDark={isDark} />
            <ProtectMock t={t} isDark={isDark} />
          </Box>
        </Figure>

        <Figure
          {...ctx}
          index="03"
          kicker="The map, not just the list"
          head="See how it's wired, not just whether it's up."
          body="Power and network topology are drawn as single-line diagrams. Trace a device back through its switch, its UPS and its circuit before you pull anything out of the rack."
        >
          <TopologyMock t={t} isDark={isDark} />
        </Figure>
      </Box>

      <CtaBand {...ctx} />
      <Footer {...ctx} />
    </Box>
  );
}
