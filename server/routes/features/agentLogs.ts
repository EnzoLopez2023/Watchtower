import express, { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { deliveryIdFrom } from "../../../lib/db/repositories/watchtower/agentIngestReceiptRepository.js";
import { requireRole } from "../../auth/authorize.js";
import type { AppConfig } from "../../config.js";
import type { AgentLogRepository } from "../../../lib/db/repositories/watchtower/agentLogRepository.js";
import { AGENT_TOKENS_KEYS } from "../../../lib/db/repositories/watchtower/agentLogRepository.js";
import { asText } from "../../../lib/monitoring/values.js";
import { asyncHandler, readBody } from "./http.js";

export interface AgentLogsServiceRouterDependencies {
  readonly config: AppConfig;
  readonly repository: AgentLogRepository;
}

export interface AgentLogsRouterDependencies {
  readonly config: AppConfig;
  readonly repository: AgentLogRepository;
}

const AGENT_TOKEN_MAP: Readonly<Record<string, (config: AppConfig) => string | undefined>> = {
  unifi: (c) => c.serviceTokens.unifi,
  ups: (c) => c.serviceTokens.ups,
  shutdown: (c) => c.serviceTokens.ups,
  synology: (c) => c.serviceTokens.synology,
  sonarr: (c) => c.serviceTokens.sonarr,
};

function tokenOk(provided: string, expected: string | undefined, unified: string | undefined): boolean {
  if (!provided) return false;
  const check = (against: string): boolean => {
    const a = Buffer.from(provided);
    const b = Buffer.from(against);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (expected && check(expected)) return true;
  if (unified && check(unified)) return true;
  return false;
}

export function createAgentLogsServiceRouter(deps: AgentLogsServiceRouterDependencies): Router {
  const router = Router();

  /**
   * Which secret applies is selected by `body.agent`, so the per-agent check has
   * to run after parsing. This pre-flight admits only a bearer that matches some
   * configured collector secret, so an unauthenticated caller cannot make the
   * process buffer a 50 MB body. Per-agent isolation is still enforced below:
   * holding the UPS secret gets you past this gate but not into the UniFi feed.
   */
  const bigParser = express.json({ limit: "50mb" });
  const smallParser = express.json({ limit: "64kb" });

  /** Anonymous callers only ever reach the small parser. */
  const parseBody: RequestHandler = (req, res, next) => {
    const unconfigured = res.locals["agentLogIngestUnconfigured"] === true;
    (unconfigured ? smallParser : bigParser)(req, res, next);
  };

  const preAuthenticate: RequestHandler = (req, res, next) => {
    const configured = [
      ...Object.values(AGENT_TOKEN_MAP).map((resolve) => resolve(deps.config)),
      deps.config.serviceTokens.agentLog
    ].filter((value): value is string => typeof value === "string" && value !== "");
    if (configured.length === 0) {
      // Nothing is configured, so no caller can ever authenticate. Fall through
      // to the small parser below, which reads just enough to name the agent in
      // the 503 — the 50 MB allowance stays out of reach.
      res.locals["agentLogIngestUnconfigured"] = true;
      next();
      return;
    }
    res.locals["agentLogIngestUnconfigured"] = false;
    const auth = req.get("authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    // Compare against every configured secret so the pre-flight cost does not
    // depend on which one matched.
    let admitted = false;
    for (const candidate of configured) {
      if (tokenOk(provided, candidate, undefined)) admitted = true;
    }
    if (!admitted) {
      res.status(401).json({ error: "bad token" });
      return;
    }
    next();
  };

  router.post("/api/agent-logs/ingest", preAuthenticate, parseBody, asyncHandler(async (req: Request, res: Response) => {
    const body = readBody(req);
    const agent = asText(body["agent"]).toLowerCase();
    if (!AGENT_TOKENS_KEYS.has(agent)) return res.status(400).json({ error: "unknown agent" });

    const tokenFn = AGENT_TOKEN_MAP[agent];
    const expected = tokenFn ? tokenFn(deps.config) : undefined;
    if (!expected && !deps.config.serviceTokens.agentLog) {
      return res.status(503).json({ error: `ingest not configured for ${agent}` });
    }

    const auth = req.get("authorization") ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!tokenOk(provided, expected, deps.config.serviceTokens.agentLog)) {
      return res.status(401).json({ error: "bad token" });
    }

    const lines = Array.isArray(body["lines"]) ? body["lines"].slice(0, 500) : [];
    if (!lines.length) return res.json({ ok: true, stored: 0 });

    const now = Date.now();
    const deliveryId = deliveryIdFrom(req.get("x-hearth-delivery-id"), body);
    const result = await deps.repository.ingest(agent, lines, deliveryId, now);
    return res.json({ ok: true, ...result });
  }));

  return router;
}

export function createAgentLogsRouter(deps: AgentLogsRouterDependencies): Router {
  const router = Router();
  const repo = deps.repository;

  function handleQueryError(res: Response, err: unknown, label: string): Response {
    const e = err as { status?: number; message?: string };
    if (e.status === 400) return res.status(400).json({ error: e.message });
    console.error(`${label}:`, e.message);
    throw err;
  }

  router.get("/api/observability/logs", requireRole("admin"), asyncHandler(async (req: Request, res: Response) => {
    try {
      return res.json(await repo.queryLogs(req.query));
    } catch (err) {
      return handleQueryError(res, err, "Observability log read failed");
    }
  }));

  router.get("/api/observability/analytics", requireRole("admin"), asyncHandler(async (req: Request, res: Response) => {
    try {
      return res.json(await repo.queryAnalytics(req.query));
    } catch (err) {
      return handleQueryError(res, err, "Observability analytics failed");
    }
  }));

  router.get("/api/admin/logs", requireRole("admin"), asyncHandler(async (req: Request, res: Response) => {
    try {
      return res.json(await repo.getAdminLogs(req.query));
    } catch (err) {
      return handleQueryError(res, err, "Admin log read failed");
    }
  }));

  return router;
}
