/**
 * The Watchtower application root.
 *
 * Provider order matters: MSAL first (everything below it needs an account),
 * then the theme (so a sign-in screen is already styled), then permissions
 * (which call the API and therefore need a token), then the router.
 */

import { MsalProvider } from '@azure/msal-react';
import { BrowserRouter } from 'react-router-dom';
import { msalInstance } from './auth/msalConfig';
import { ThemeModeProvider } from './context/ThemeContext';
import { UserPermissionsProvider } from './context/UserPermissionsContext';
import RequireAuth from './app/RequireAuth';
import AppRoutes from './app/routes';

export default function App() {
  return (
    <MsalProvider instance={msalInstance}>
      <ThemeModeProvider>
        <RequireAuth>
          <UserPermissionsProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </UserPermissionsProvider>
        </RequireAuth>
      </ThemeModeProvider>
    </MsalProvider>
  );
}
