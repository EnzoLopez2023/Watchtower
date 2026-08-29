/**
 * The route table.
 *
 * Every feature is a lazy chunk, so opening Status does not download the
 * topology canvas, the Azure console and the log explorer along with it. The
 * paths are the ones in `navigation.ts` — nothing here invents a URL.
 */

import { lazy } from 'react';
import { Route, Routes } from 'react-router-dom';
import AppShell from './AppShell';
import RequireRole from './RequireRole';
import NotFound from './NotFound';
import RootRedirect from './RootRedirect';

const AzureCommandCenter = lazy(() => import('../AzureCommandCenter'));
const SystemStatus = lazy(() => import('../SystemStatus'));
const ObservabilityConsole = lazy(() => import('../ObservabilityConsole'));
const UpsMonitor = lazy(() => import('../UpsMonitor'));
const PowerTopology = lazy(() => import('../PowerTopology'));
const UniFiNetwork = lazy(() => import('../UniFiNetwork'));
const UniFiTopology = lazy(() => import('../UniFiTopology'));
const UniFiConfig = lazy(() => import('../UniFiConfig'));
const Synology = lazy(() => import('../Synology'));
const IpMigration = lazy(() => import('../IpMigration'));
const Protect = lazy(() => import('../Protect'));
const Admin = lazy(() => import('../Admin'));
const Settings = lazy(() => import('../Settings'));

export default function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<RootRedirect />} />
        <Route path="/status" element={<SystemStatus />} />
        <Route path="/azure" element={<AzureCommandCenter />} />
        <Route path="/observability" element={<ObservabilityConsole />} />
        <Route path="/power" element={<UpsMonitor />} />
        <Route path="/power/topology" element={<PowerTopology />} />
        <Route path="/network" element={<UniFiNetwork />} />
        <Route path="/network/topology" element={<UniFiTopology />} />
        <Route path="/network/config" element={<UniFiConfig />} />
        <Route path="/synology" element={<Synology />} />
        <Route path="/ip-migration" element={<IpMigration />} />
        <Route path="/protect" element={<Protect />} />
        <Route
          path="/admin"
          element={
            <RequireRole role="admin">
              <Admin />
            </RequireRole>
          }
        />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
