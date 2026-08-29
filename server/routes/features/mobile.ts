import express, { Router } from "express";
import type { AppConfig } from "../../config.js";
import type { ApnsProvider } from "../../clients/apns.js";
import type { DashboardPayload } from "../../../lib/monitoring/infraStatus.js";
import type { MobilePushRepository } from "../../../lib/db/repositories/watchtower/mobilePushRepository.js";
import { deviceRef, type PushDeliveryService } from "../../../lib/monitoring/pushDelivery.js";
import { asText } from "../../../lib/monitoring/values.js";
import { asyncHandler, serverError } from "./http.js";
import { requireServiceToken } from "./serviceAuth.js";

const DEVICE_TOKEN = /^[0-9a-fA-F]{32,200}$/;

export interface MobileRouterDependencies {
  readonly config: AppConfig;
  readonly repository: MobilePushRepository;
  readonly push: PushDeliveryService;
  readonly apns: ApnsProvider;
  readonly buildStatus: () => Promise<DashboardPayload>;
}

function requireMobileToken(config: AppConfig) {
  return requireServiceToken({
    expected: () => config.serviceTokens.mobile,
    unconfiguredMessage: "Mobile API not configured — set MOBILE_API_TOKEN",
    unconfiguredCode: "mobile_api_not_configured",
    invalidCode: "invalid_mobile_token",
    invalidMessage: "Invalid or missing mobile token",
    headers: ["x-hearth-token"]
  });
}

/**
 * The mobile surface is reachable from the public internet and is authenticated
 * by its own shared bearer secret, so it mounts before the interactive Entra
 * gate. It is read-only apart from device registration and the on-demand test
 * push, and it never authorizes by email or by any caller-controlled header.
 */
export function createMobileServiceRouter(dependencies: MobileRouterDependencies): Router {
  const router = Router();
  const authenticate = requireMobileToken(dependencies.config);
  const json = express.json({ limit: "256kb", strict: true });

  router.get(
    "/api/mobile/dashboard",
    authenticate,
    asyncHandler(async (_request, response) => {
      try {
        response.json(await dependencies.buildStatus());
      } catch (error) {
        serverError(response, "mobile.dashboard", error);
      }
    })
  );

  router.post(
    "/api/mobile/register-device",
    authenticate,
    json,
    asyncHandler(async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = asText(body.token).trim();
    if (!DEVICE_TOKEN.test(token)) {
      response.status(400).json({ error: "Invalid device token" });
      return;
    }
    try {
      const { returning } = await dependencies.repository.registerDevice({
        token,
        platform: typeof body.platform === "string" && body.platform ? body.platform : "ios",
        appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
        now: Date.now(),
        deviceRef: deviceRef(token)
      });
      // The in-memory half of the block is cleared only once the transaction has
      // committed; doing it inside would let a rolled-back registration destroy a
      // valid fail-closed block.
      if (!returning) dependencies.push.clearDeviceDeliveryBlock(deviceRef(token));
      response.json({ ok: true });
    } catch (error) {
      serverError(response, "mobile.register-device", error);
      }
    })
  );

  router.post(
    "/api/mobile/unregister-device",
    authenticate,
    json,
    asyncHandler(async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = asText(body.token).trim();
    if (!token) {
      response.status(400).json({ error: "Missing token" });
      return;
    }
    try {
      const { removed } = await dependencies.repository.unregisterDevice(token, deviceRef(token));
      if (removed) dependencies.push.clearDeviceDeliveryBlock(deviceRef(token));
      response.json({ ok: true });
    } catch (error) {
      serverError(response, "mobile.unregister-device", error);
      }
    })
  );

  router.post(
    "/api/mobile/test-push",
    authenticate,
    json,
    asyncHandler(async (request, response) => {
      if (!dependencies.apns.configured()) {
        response.status(503).json({ error: "APNs is not configured on this server" });
        return;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const critical = body.critical === true;
      const note = {
        title: typeof body.title === "string" && body.title ? body.title : "🔔 Watchtower test",
        body:
          typeof body.body === "string" && body.body
            ? body.body
            : `Test push at ${new Date().toLocaleTimeString("en-US")} — if you can see this, alerting works.`,
        critical
      };

      try {
        const delivery = await dependencies.push.deliver(note, { source: "test" });
        if (delivery.status === "no_devices") {
          response.status(404).json({
            error: "No devices registered",
            deliveryId: delivery.deliveryId,
            status: delivery.status,
            registeredDeviceCount: 0,
            attemptedDeviceCount: 0
          });
          return;
        }
        const skippedDeviceCount =
          delivery.registeredDeviceCount - delivery.attemptedDeviceCount;
        const payload = {
          ok: delivery.acceptedCount === delivery.registeredDeviceCount,
          deliveryId: delivery.deliveryId,
          status: delivery.status,
          sent: delivery.acceptedCount,
          failed: delivery.failedCount,
          registeredDeviceCount: delivery.registeredDeviceCount,
          attemptedDeviceCount: delivery.attemptedDeviceCount,
          skippedDeviceCount,
          coverageComplete: skippedDeviceCount === 0,
          pruned: delivery.results.filter((result) => result.pruned).map((result) => result.device),
          interruptionLevel: delivery.interruptionLevel,
          environment: delivery.environment,
          expiresAt: delivery.expiresAt,
          results: delivery.results
        };
        if (delivery.status === "no_targets") {
          response.status(429).json({
            ...payload,
            error: "All registered devices are backed off or already being tested"
          });
          return;
        }
        response.json(payload);
      } catch (error) {
        serverError(response, "mobile.test-push", error);
      }
    })
  );

  return router;
}
