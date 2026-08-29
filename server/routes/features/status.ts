import { Router } from "express";
import type { DashboardPayload } from "../../../lib/monitoring/infraStatus.js";
import { requireRole } from "../../auth/authorize.js";
import { asyncHandler, serverError } from "./http.js";

export interface StatusRouterDependencies {
  readonly buildStatus: () => Promise<DashboardPayload>;
}

/**
 * The web-facing view of the same infrastructure verdict the iOS app and the
 * alert engine consume. Deriving it once means the web dashboard, the phone tile
 * and the notification can never disagree.
 */
export function createStatusRouter(dependencies: StatusRouterDependencies): Router {
  const router = Router();

  router.get(
    "/api/status",
    requireRole("viewer"),
    asyncHandler(async (_request, response) => {
      try {
        response.json(await dependencies.buildStatus());
      } catch (error) {
        serverError(response, "status", error);
      }
    })
  );

  return router;
}
