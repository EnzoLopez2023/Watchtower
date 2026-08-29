/**
 * The sign-in gate.
 *
 * Every interactive page sits behind this. Unauthenticated visitors get a real
 * sign-in screen rather than an empty dashboard, and a misconfigured deployment
 * gets a visible configuration error rather than an MSAL exception in the
 * console.
 */

import { useCallback, useState } from 'react';
import { AuthenticatedTemplate, UnauthenticatedTemplate, useMsal } from '@azure/msal-react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import { LoginOutlined as LoginIcon, ShieldOutlined as ShieldIcon } from '@mui/icons-material';
import type { ReactNode } from 'react';
import { entraConfigProblems, loginRequest } from '../auth/msalConfig';
import { useThemeMode } from '../context/ThemeContext';
import { tokensFor } from '../theme/tokens';
import { CARD_RADIUS, cardShadow } from '../theme/controls';
import { ErrorState } from '../components/StateBlocks';

function Panel({ children }: { children: ReactNode }) {
  const { mode, palette } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        px: 2,
        py: 6,
      }}
    >
      <Box
        sx={{
          width: '100%',
          maxWidth: 460,
          p: { xs: 3, sm: 4 },
          bgcolor: t.paper,
          border: `1px solid ${t.line}`,
          borderRadius: CARD_RADIUS,
          boxShadow: cardShadow(isDark),
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

function LoginPanel() {
  const { instance } = useMsal();
  const { mode, palette } = useThemeMode();
  const isDark = mode === 'dark';
  const t = tokensFor(isDark, palette);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(() => {
    setBusy(true);
    setError(null);
    instance.loginRedirect(loginRequest).catch((caught: unknown) => {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : 'Sign-in could not be started.');
    });
  }, [instance]);

  return (
    <Panel>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <ShieldIcon aria-hidden sx={{ color: t.rust }} />
        <Typography
          component="p"
          sx={{
            fontSize: '0.62rem',
            letterSpacing: '0.24em',
            textTransform: 'uppercase',
            fontWeight: 800,
            color: t.rust,
          }}
        >
          Watchtower
        </Typography>
      </Box>
      <Typography
        component="h1"
        sx={{
          fontFamily: 'var(--hearth-heading)',
          fontSize: 'clamp(1.5rem, 1.2rem + 1.2vw, 2rem)',
          fontWeight: 700,
          color: t.ink,
          lineHeight: 1.15,
        }}
      >
        Infrastructure operations
      </Typography>
      <Typography sx={{ color: t.inkSoft, mt: 1.25, fontSize: '0.95rem', lineHeight: 1.6 }}>
        Sign in with your organisation account. Access to each view is decided by the roles
        Watchtower holds for you, not by your email address.
      </Typography>
      {error && (
        <Box sx={{ mt: 2 }}>
          <ErrorState title="Sign-in failed" detail={error} onRetry={signIn} retryLabel="Retry" />
        </Box>
      )}
      <Button
        variant="contained"
        onClick={signIn}
        disabled={busy}
        startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <LoginIcon />}
        sx={{ mt: 3, width: '100%', py: 1.1 }}
      >
        {busy ? 'Opening sign-in…' : 'Sign in'}
      </Button>
    </Panel>
  );
}

function ConfigPanel({ problems }: { problems: ReturnType<typeof entraConfigProblems> }) {
  return (
    <Panel>
      <ErrorState
        title="Watchtower is not configured for sign-in"
        detail={
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {problems.map((problem) => (
              <li key={problem.variable}>
                <code>{problem.variable}</code> — {problem.detail}
              </li>
            ))}
          </Box>
        }
      />
    </Panel>
  );
}

export default function RequireAuth({ children }: { children: ReactNode }) {
  const problems = entraConfigProblems();
  if (problems.length) return <ConfigPanel problems={problems} />;

  return (
    <>
      <AuthenticatedTemplate>{children}</AuthenticatedTemplate>
      <UnauthenticatedTemplate>
        <LoginPanel />
      </UnauthenticatedTemplate>
    </>
  );
}
