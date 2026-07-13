const SECRET_KEY_PATTERN = /(authorization|api[-_ ]?key|apikey|token|secret|credential|password|bearer)/i;

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactSecrets(nested),
    ]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
