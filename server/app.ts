import cors from "cors";
import express, { type Express, type RequestHandler } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import {
  createAuthenticatedCoreRouter,
  createPublicCoreRouter,
  type CoreRouteDependencies
} from "./routes/core.js";

/** A path whose last segment carries an extension is a file request, not a view. */
const ASSET_PATH = /\.[a-z0-9]+$/i;

export interface CreateAppOptions {
  readonly config: AppConfig;
  readonly core: CoreRouteDependencies;
  /**
   * Entra verification. Scoped to `/api` so the browser can download the SPA and
   * its assets before it holds a token.
   */
  readonly authenticate: RequestHandler;
  /**
   * Shared-secret surface (agent ingest and the mobile app). Mounted before the
   * global JSON parser and before the Entra gate, so each of its routes declares
   * its own body limit and its own constant-time token check.
   */
  readonly service?: RequestHandler;
  /**
   * Transport-level audit for authenticated mutations. Installed once, after the
   * Entra gate and before every mutating handler.
   */
  readonly auditTrail?: RequestHandler;
  readonly features: RequestHandler;
  /** Built SPA directory. Defaults to `dist/client` relative to the process cwd. */
  readonly clientPath?: string;
}

/**
 * Request pipeline, ordered by how much trust each stage requires.
 *
 * 1. Shared-secret service surface — collectors and the mobile app, each with its
 *    own parser and secret, mounted first so they never meet the Entra gate.
 * 2. Public liveness and version — no credential of any kind.
 * 3. Entra-verified `/api` — every interactive read and write.
 * 4. Static assets and the SPA shell — deliberately unauthenticated.
 *
 * Step 4 is why the gate is mounted at `/api` rather than globally: a browser
 * arriving at `/azure` holds no token, and cannot obtain one until MSAL has been
 * downloaded and run. A global gate answers that document request with 401 and
 * leaves the user with no way to ever sign in.
 */
export function createApp(options: CreateAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    cors({
      origin:
        options.config.corsOrigins.length === 0
          ? false
          : (origin, callback) => {
              callback(null, origin !== undefined && options.config.corsOrigins.includes(origin));
            },
      credentials: false
    })
  );

  if (options.service) app.use(options.service);
  app.use(express.json({ limit: "2mb", strict: true }));

  app.use(createPublicCoreRouter(options.core));
  app.use("/api", options.authenticate);
  if (options.auditTrail) app.use("/api", options.auditTrail);
  app.use(createAuthenticatedCoreRouter(options.core));
  app.use(options.features);
  // An unmatched API path is an error, not a view. Terminating here stops the SPA
  // fallback below from answering a mistyped endpoint with 200 and an HTML body.
  app.use("/api", notFoundHandler);

  const clientPath = options.clientPath ?? resolve("dist/client");
  if (existsSync(clientPath)) {
    app.use(express.static(clientPath, { index: false, maxAge: "1h" }));
    app.get("/{*path}", (request, response, next) => {
      // A missing script or stylesheet must fail as a missing file. Serving the
      // shell in its place produces an HTML parse error far from the real cause.
      if (ASSET_PATH.test(request.path)) {
        next();
        return;
      }
      // `root` scopes send's dot-segment rule to the contents of the build
      // directory. Passing one absolute path instead makes every deployment
      // whose path contains a dot-directory refuse to serve the shell at all.
      response.sendFile("index.html", { root: clientPath }, (error?: Error) => {
        if (error) next();
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
