
export const ACTIVITY_NORMALIZATION_VERSION = 1;

const TEMPLATE_TOKEN = /\{([^{}]+)\}/g;

const KNOWN_PARAMETER_ROLES = new Set([
  "ACTOR", "ADMIN", "AP", "CLIENT", "CONSOLE", "CONSOLE_NAME", "DEVICE",
  "DEVICE_FROM", "DEVICE_TO", "DST_CLIENT", "DST_DEVICE", "DST_IP", "GATEWAY",
  "PERFORMER", "SRC_CLIENT", "SRC_DEVICE", "SRC_IP", "TARGET", "TRIGGER", "USER",
]);

const PARAMETER_LABEL_PATHS = [
  "name", "display_name", "hostname", "email", "ip", "mac", "value", "id",
  "model_name", "model", "version", "network_purpose", "subnet", "vlan_id",
];

function valueAt(object: unknown, ...paths: string[]): unknown {
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>(
      (current, part) => (current == null || typeof current !== "object" ? undefined : (current as Record<string, unknown>)[part]),
      object
    );
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function shortText(value: unknown, max = 500): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function parameterValue(candidate: unknown, max: number): string | null {
  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const label = parameterValue(item, max);
      if (label) return label;
    }
    return null;
  }
  if (!candidate || typeof candidate !== "object") return shortText(candidate, max);
  return shortText(valueAt(candidate, ...PARAMETER_LABEL_PATHS), max);
}

function parameterLabel(
  parameters: Record<string, unknown> | null | undefined,
  keys: string[],
  max = 240
): string | null {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return null;
  for (const key of keys) {
    const label = parameterValue(parameters[key], max);
    if (label) return label;
  }
  return null;
}

export function renderActivityTemplate(
  template: unknown,
  parameters: Record<string, unknown>,
  max = 2000
): { text: string | null; missing: string[] } {
  const source = shortText(template, 10_000);
  if (!source) return { text: null, missing: [] };

  const missing = new Set<string>();
  const rendered = source.replace(TEMPLATE_TOKEN, (_match, key: string) => {
    const replacement = parameterLabel(parameters, [key], max);
    if (replacement) return replacement;
    missing.add(key);
    return _match;
  });

  return {
    text: missing.size ? null : shortText(rendered, max),
    missing: [...missing],
  };
}

function resolvedTemplate(
  record: Record<string, unknown>,
  renderedKey: string,
  rawKeys: string[],
  parameters: Record<string, unknown>,
  max: number
): string | null {
  const rendered = shortText(valueAt(record, renderedKey), max);
  if (rendered) return rendered;

  const template = valueAt(record, ...rawKeys);
  const result = renderActivityTemplate(template, parameters, max);
  if (result.text) return result.text;
  if (!result.missing.length) return null;
  return `UniFi omitted ${result.missing.length} referenced detail field${result.missing.length === 1 ? "" : "s"} from this event.`;
}

function explicitLabel(
  value: unknown,
  parameters: Record<string, unknown>
): string | null {
  const label = shortText(value, 240);
  if (!label) return null;
  const resolved = parameterLabel(parameters, [label]);
  if (resolved) return resolved;
  if (
    KNOWN_PARAMETER_ROLES.has(label) ||
    Object.prototype.hasOwnProperty.call(parameters, label)
  )
    return null;
  return label;
}

export interface ActivityPresentation {
  severity: string | null;
  category: string | null;
  subcategory: string | null;
  event_type: string | null;
  title: string | null;
  message: string | null;
  actor: string | null;
  target: string | null;
}

export function activityPresentation(record: unknown): ActivityPresentation | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const r = record as Record<string, unknown>;
  const parametersRaw = r.parameters;
  const parameters: Record<string, unknown> =
    parametersRaw && typeof parametersRaw === "object" && !Array.isArray(parametersRaw)
      ? (parametersRaw as Record<string, unknown>)
      : {};

  const rawTitle = valueAt(r, "title_raw", "titleRaw");
  const renderedTitle = renderActivityTemplate(rawTitle, parameters, 500);
  const title =
    shortText(r.title, 500) ??
    renderedTitle.text ??
    shortText(valueAt(r, "key", "event"), 500);
  const explicitTarget = shortText(r.target, 240);
  const explicitActor = shortText(r.actor, 240);

  return {
    severity: shortText(r.severity, 40),
    category: shortText(r.category, 80),
    subcategory: shortText(r.subcategory, 120),
    event_type: shortText(valueAt(r, "event", "key", "type"), 160),
    title,
    message: resolvedTemplate(r, "message", ["message_raw", "messageRaw", "msg"], parameters, 2000),
    actor:
      explicitLabel(explicitActor, parameters) ??
      (!explicitActor
        ? parameterLabel(parameters, ["ADMIN", "ACTOR", "USER", "PERFORMER"])
        : null),
    target:
      explicitLabel(explicitTarget, parameters) ??
      (!explicitTarget
        ? parameterLabel(parameters, [
            "TARGET", "CLIENT", "SRC_CLIENT", "DST_CLIENT",
            "DEVICE", "DEVICE_TO", "AP", "DST_IP", "TRIGGER",
          ])
        : null),
  };
}


