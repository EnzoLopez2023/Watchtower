/**
 * Minimal, dependency-free CLI argument parsing shared by the scripts.
 *
 * Only `--flag`, `--key value` and `--key=value` are accepted. Unknown options
 * are a hard error so a typo can never silently change import behaviour.
 */

import { ImportError } from "./errors.js";

export interface OptionSpec {
  readonly name: string;
  readonly kind: "string" | "number" | "boolean" | "string-list";
  readonly required?: boolean;
  readonly description: string;
  readonly defaultValue?: string | number | boolean;
  readonly choices?: readonly string[];
}

export type ParsedOptions = Record<string, string | number | boolean | string[] | undefined>;

export function parseArguments(argv: readonly string[], specs: readonly OptionSpec[]): ParsedOptions {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const parsed: ParsedOptions = {};

  for (const spec of specs) {
    if (spec.kind === "string-list") parsed[spec.name] = [];
    else if (spec.defaultValue !== undefined) parsed[spec.name] = spec.defaultValue;
    else if (spec.kind === "boolean") parsed[spec.name] = false;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      throw new ImportError("ARGUMENT_INVALID", `Unexpected positional argument "${token}"`);
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);
    const spec = byName.get(name);
    if (!spec) {
      throw new ImportError("ARGUMENT_INVALID", `Unknown option --${name}`, {
        known: [...byName.keys()].sort()
      });
    }

    if (spec.kind === "boolean") {
      if (inlineValue === null) {
        parsed[name] = true;
      } else if (inlineValue === "true" || inlineValue === "false") {
        parsed[name] = inlineValue === "true";
      } else {
        throw new ImportError("ARGUMENT_INVALID", `--${name} accepts only true or false`);
      }
      continue;
    }

    const value = inlineValue ?? argv[++index];
    if (value === undefined) {
      throw new ImportError("ARGUMENT_MISSING", `--${name} requires a value`);
    }
    if (spec.choices && !spec.choices.includes(value)) {
      throw new ImportError("ARGUMENT_INVALID", `--${name} must be one of ${spec.choices.join(", ")}`);
    }

    if (spec.kind === "number") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw new ImportError("ARGUMENT_INVALID", `--${name} must be a number`);
      }
      parsed[name] = numeric;
    } else if (spec.kind === "string-list") {
      (parsed[name] as string[]).push(value);
    } else {
      parsed[name] = value;
    }
  }

  const missing = specs
    .filter((spec) => spec.required === true)
    .filter((spec) => {
      const value = parsed[spec.name];
      return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    })
    .map((spec) => `--${spec.name}`);

  if (missing.length > 0) {
    throw new ImportError("ARGUMENT_MISSING", `Missing required option(s): ${missing.join(", ")}`);
  }

  return parsed;
}

export function requireString(options: ParsedOptions, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || value === "") {
    throw new ImportError("ARGUMENT_MISSING", `--${name} is required`);
  }
  return value;
}

export function optionalString(options: ParsedOptions, name: string): string | null {
  const value = options[name];
  return typeof value === "string" && value !== "" ? value : null;
}

export function stringList(options: ParsedOptions, name: string): string[] {
  const value = options[name];
  return Array.isArray(value) ? [...value] : [];
}

export function numberOrNull(options: ParsedOptions, name: string): number | null {
  const value = options[name];
  return typeof value === "number" ? value : null;
}

export function booleanOption(options: ParsedOptions, name: string, fallback = false): boolean {
  const value = options[name];
  return typeof value === "boolean" ? value : fallback;
}

export function renderUsage(command: string, specs: readonly OptionSpec[]): string {
  const lines = [`Usage: node ${command} [options]`, ""];
  const width = Math.max(...specs.map((spec) => spec.name.length)) + 4;
  for (const spec of [...specs].sort((a, b) => a.name.localeCompare(b.name))) {
    const flag = `--${spec.name}`.padEnd(width);
    const required = spec.required === true ? " (required)" : "";
    const choices = spec.choices ? ` [${spec.choices.join("|")}]` : "";
    const fallback = spec.defaultValue !== undefined ? ` (default: ${String(spec.defaultValue)})` : "";
    lines.push(`  ${flag}${spec.description}${choices}${required}${fallback}`);
  }
  return `${lines.join("\n")}\n`;
}
