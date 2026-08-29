/**
 * Path safety for backup and restore destinations.
 *
 * Restores are always disposable: they must land inside an explicitly supplied
 * root, must not already exist, must not be the live authority, and must not be
 * inside a Git working tree.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { RecoveryError } from "./errors.js";

const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

export function findGitWorktreeRoot(startPath: string): string | null {
  let current = resolve(startPath);
  const root = parse(current).root;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath !== "" && !relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.startsWith("/");
}

export interface DestinationOptions {
  readonly destination: string;
  /** Destination must live under this root. */
  readonly allowedRoot: string;
  /** Paths that must never be written to (typically the live authority). */
  readonly protectedPaths?: readonly string[];
  readonly allowInsideGitWorktree?: boolean;
  readonly mustNotExist?: boolean;
}

/** Validates a write destination and returns its absolute path. */
export function assertSafeDestination(options: DestinationOptions): string {
  const destination = resolve(options.destination);
  const allowedRoot = resolve(options.allowedRoot);

  if (!existsSync(allowedRoot) || !statSync(allowedRoot).isDirectory()) {
    throw new RecoveryError("RESTORE_DESTINATION_UNSAFE", `Allowed root is not a directory: ${allowedRoot}`);
  }
  if (!isInside(allowedRoot, destination)) {
    throw new RecoveryError(
      "RESTORE_DESTINATION_UNSAFE",
      `Destination must be inside ${allowedRoot}, received ${destination}`
    );
  }

  for (const protectedPath of options.protectedPaths ?? []) {
    const resolved = resolve(protectedPath);
    if (destination === resolved) {
      throw new RecoveryError("RESTORE_DESTINATION_UNSAFE", `Destination is a protected path: ${resolved}`);
    }
    if (existsSync(destination) && existsSync(resolved)) {
      const a = statSync(destination);
      const b = statSync(resolved);
      if (a.ino === b.ino && a.dev === b.dev) {
        throw new RecoveryError("RESTORE_DESTINATION_UNSAFE", `Destination is hard-linked to ${resolved}`);
      }
    }
  }

  if (options.allowInsideGitWorktree !== true) {
    const gitRoot = findGitWorktreeRoot(dirname(destination));
    if (gitRoot !== null) {
      throw new RecoveryError(
        "RESTORE_DESTINATION_UNSAFE",
        `Refusing to write a database inside the Git working tree at ${gitRoot}`,
        { destination, gitRoot }
      );
    }
  }

  if (options.mustNotExist !== false && existsSync(destination)) {
    throw new RecoveryError("RESTORE_DESTINATION_EXISTS", `Destination already exists: ${destination}`);
  }

  for (const suffix of SIDECAR_SUFFIXES) {
    if (existsSync(`${destination}${suffix}`)) {
      throw new RecoveryError(
        "RESTORE_DESTINATION_UNSAFE",
        `Stale SQLite sidecar present: ${destination}${suffix}`
      );
    }
  }

  return destination;
}

const HASH_CHUNK_BYTES = 8 * 1024 * 1024;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path, { highWaterMark: HASH_CHUNK_BYTES });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function assertLowerHex(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new RecoveryError("ARGUMENT_INVALID", `${label} must be 64 lowercase hex characters`);
  }
  return value;
}
