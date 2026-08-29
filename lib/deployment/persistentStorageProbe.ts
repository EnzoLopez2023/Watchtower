/**
 * Narrow, injectable probe for the persistent App Service storage gate.
 *
 * The default implementation reads the three independent pieces of evidence the
 * gate needs to prove `/home`/`/home/data` is a real, writable, persistent
 * mount and not an image-local directory:
 *
 *   1. the kernel mount table (`/proc/self/mountinfo`), to prove the mount point
 *      is an actual mount rather than a plain directory on the image layer;
 *   2. the device id of a path (`fs.statSync().dev`, the `statfs`/`statvfs`
 *      device-comparison signal), to prove the data directory lives on a
 *      different filesystem than the root image layer;
 *   3. an atomic create/write/unlink write probe, to prove it is writable now.
 *
 * Tests inject a synthetic probe to drive every branch deterministically on
 * macOS or Linux without root and without real mounts. The default export is
 * the real probe.
 */

import {
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { join } from "node:path";

export interface WriteProbeResult {
  readonly ok: boolean;
  /** The `errno`-style code when the probe failed (e.g. `EACCES`, `EROFS`). */
  readonly code?: string;
}

export interface PersistentStorageProbe {
  /** Mount points parsed from the kernel mount table. */
  readonly mountPoints: () => readonly string[];
  /** `st_dev` of a path; `undefined` when the path does not exist. */
  readonly deviceId: (path: string) => number | undefined;
  /**
   * Full round-trip sentinel probe inside a directory: create private, write
   * every byte, fsync, read back and compare, then delete. Never throws.
   *
   * A create-and-unlink probe is not sufficient evidence. It succeeds against a
   * page-cache-only write on a share that never durably accepts the data, which
   * is exactly the failure this gate exists to catch, so the sentinel is read
   * back after the fsync.
   */
  readonly writeProbe: (directory: string) => WriteProbeResult;
  /**
   * Fully resolved real path, with every symlink expanded; `undefined` when the
   * path does not exist. Used to prove the database path cannot be redirected
   * off the persistent mount by a symlink.
   */
  readonly realPath: (path: string) => string | undefined;
}

const MOUNTINFO_PATH = "/proc/self/mountinfo";

/**
 * mountinfo octal-escapes space (`\040`), tab (`\011`), newline (`\012`) and
 * backslash (`\134`) in the mount-point field. Reverse that so comparisons
 * against contract paths are exact.
 */
function unescapeMountField(value: string): string {
  return value.replace(/\\(\d{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8))
  );
}

/**
 * Parses the mount-point column (the 5th whitespace-separated field) out of
 * every `/proc/self/mountinfo` line. Exported for direct unit testing with
 * synthetic mount tables.
 */
export function parseMountInfoPoints(content: string): string[] {
  const points: string[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const mountPoint = line.split(" ")[4];
    if (mountPoint === undefined) continue;
    points.push(unescapeMountField(mountPoint));
  }
  return points;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };
    if (typeof code === "string") return code;
  }
  return "EUNKNOWN";
}

export const defaultPersistentStorageProbe: PersistentStorageProbe = Object.freeze({
  mountPoints(): readonly string[] {
    try {
      return parseMountInfoPoints(readFileSync(MOUNTINFO_PATH, "utf8"));
    } catch {
      // Not Linux, or the mount table is unavailable. The gate treats a missing
      // mount entry as "no persistent mount", which fails closed in production.
      return [];
    }
  },
  deviceId(path: string): number | undefined {
    try {
      return statSync(path).dev;
    } catch {
      return undefined;
    }
  },
  writeProbe(directory: string): WriteProbeResult {
    const probeFile = join(
      directory,
      `.watchtower-storage-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const payload = Buffer.from(
      `watchtower-storage-probe:${process.pid}:${Date.now()}\n`,
      "utf8"
    );

    let handle: number;
    try {
      // `wx+` fails if the file already exists, so the create is atomic and can
      // never clobber real data; the `+` is what makes the sentinel readable
      // back through the same descriptor. 0o600 keeps it private.
      handle = openSync(probeFile, "wx+", 0o600);
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }

    let outcome: WriteProbeResult = { ok: false, code: "EUNKNOWN" };
    try {
      let offset = 0;
      while (offset < payload.length) {
        const written = writeSync(handle, payload, offset, payload.length - offset);
        if (!Number.isInteger(written) || written <= 0) {
          outcome = { ok: false, code: "EIO_SHORT_WRITE" };
          break;
        }
        offset += written;
      }
      if (offset === payload.length) {
        fsyncSync(handle);

        // Read the bytes back through the same descriptor. A share that accepted
        // the write but cannot return it is not somewhere a database may live.
        const size = fstatSync(handle).size;
        if (size !== payload.length) {
          outcome = { ok: false, code: "EIO_SIZE_MISMATCH" };
        } else {
          const readBack = Buffer.alloc(payload.length);
          let read = 0;
          while (read < payload.length) {
            const count = readSync(handle, readBack, read, payload.length - read, read);
            if (!Number.isInteger(count) || count <= 0) {
              outcome = { ok: false, code: "EIO_SHORT_READ" };
              break;
            }
            read += count;
          }
          if (read === payload.length) {
            outcome = readBack.equals(payload)
              ? { ok: true }
              : { ok: false, code: "EIO_READBACK_MISMATCH" };
          }
        }
      }
    } catch (error) {
      outcome = { ok: false, code: errorCode(error) };
    } finally {
      try {
        closeSync(handle);
      } catch (error) {
        if (outcome.ok) outcome = { ok: false, code: errorCode(error) };
      }
      try {
        unlinkSync(probeFile);
      } catch (error) {
        // Deletion is part of the deployment contract. A mount that cannot
        // remove its own private sentinel is not safe for SQLite journals.
        if (outcome.ok) outcome = { ok: false, code: errorCode(error) };
      }
    }
    return outcome;
  },

  realPath(path: string): string | undefined {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  }
});
