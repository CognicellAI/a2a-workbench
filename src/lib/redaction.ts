const SECRET_KEY_PATTERN = /(authorization|api[-_ ]?key|apikey|token|secret|credential|password|bearer)/i;
const SAFE_PROTOCOL_METADATA_KEY = /^(?:apiKeySecurityScheme|httpAuthSecurityScheme|oauth2SecurityScheme|openIdConnectSecurityScheme|mtlsSecurityScheme|tokenUrl|refreshUrl|oauth2MetadataUrl|openIdConnectUrl|bearerFormat|clientCredentials)$/i;

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
      isSecretKey(key) ? "[redacted]" : redactSecrets(nested),
    ]),
  );
}

function isSecretKey(key: string): boolean {
  return !SAFE_PROTOCOL_METADATA_KEY.test(key) && SECRET_KEY_PATTERN.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
