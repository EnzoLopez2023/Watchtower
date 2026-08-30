/**
 * The sign-in gate.
 *
 * Every interactive page sits behind this. Unauthenticated visitors get the
 * Watchtower landing page (src/marketing/LandingPage.tsx) with its own sign-in
 * call to action, rather than an empty dashboard. A misconfigured deployment
 * gets a visible configuration error rather than an MSAL exception in the
 * console.
 */

import { AuthenticatedTemplate, UnauthenticatedTemplate } from '@azure/msal-react';
import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { entraConfigProblems } from '../auth/msalConfig';
import { useThemeMode } from '../context/ThemeContext';
import { tokensFor } from '../theme/tokens';
import { CARD_RADIUS, cardShadow } from '../theme/controls';
import { ErrorState } from '../components/StateBlocks';
import LandingPage from '../marketing/LandingPage';

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
        <LandingPage />
      </UnauthenticatedTemplate>
    </>
  );
}
