export const A2UI_EXTENSION_URI = "https://a2ui.org/a2a-extension/a2ui/v0.9.1";
export const A2UI_MIME_TYPE = "application/a2ui+json";
export const A2UI_RENDERER_VERSION = "v0.9";
export const A2UI_PROTOCOL_VERSION = "v0.9.1";
export const A2UI_BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json";
export const DEFAULT_SURFACE_ID = "investigation";

type RecordValue = Record<string, unknown>;

export function getA2uiClientCapabilities(): Record<string, unknown> {
  return {
    "v0.9": {
      supportedCatalogIds: [A2UI_BASIC_CATALOG_ID],
    },
  };
}

export function normalizeA2uiPayload(payload: unknown): unknown[] {
  const messages = collectA2uiMessages(payload).flatMap((message) => {
    const normalized = normalizeA2uiMessage(message);
    return normalized ? [normalized] : [];
  });

  return ensureRenderableMessages(messages);
}

export function extractFencedA2uiBlocks(text: string): unknown[] {
  const blocks: unknown[] = [];
  const fencePattern = /```a2ui\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(text)) !== null) {
    const json = match[1]?.trim();
    if (!json) {
      continue;
    }

    const parsed = parseJson(json);
    if (parsed !== undefined) {
      blocks.push(parsed);
    }
  }

  return blocks;
}

export function stripFencedA2uiBlocks(text: string): string {
  return text.replace(/```a2ui\s*[\s\S]*?```/gi, "").trim();
}

export function isA2uiMimeType(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase().split(";")[0]?.trim() === A2UI_MIME_TYPE;
}

function collectA2uiMessages(payload: unknown): RecordValue[] {
  if (typeof payload === "string") {
    const parsed = parseJson(payload);
    return parsed === undefined ? [] : collectA2uiMessages(parsed);
  }

  if (Array.isArray(payload)) {
    return payload.flatMap(collectA2uiMessages);
  }

  if (!isRecord(payload)) {
    return [];
  }

  if (Array.isArray(payload.messages)) {
    return payload.messages.flatMap(collectA2uiMessages);
  }

  if (isA2uiMessage(payload)) {
    return [payload];
  }

  return [];
}

function normalizeA2uiMessage(message: RecordValue): RecordValue | undefined {
  if (!isSupportedVersion(message.version)) {
    return undefined;
  }

  if (isRecord(message.createSurface)) {
    return {
      version: A2UI_RENDERER_VERSION,
      createSurface: {
        ...message.createSurface,
        surfaceId: readString(message.createSurface.surfaceId) || DEFAULT_SURFACE_ID,
        catalogId: A2UI_BASIC_CATALOG_ID,
      },
    };
  }

  if (isRecord(message.updateComponents)) {
    const surfaceId = readString(message.updateComponents.surfaceId) || DEFAULT_SURFACE_ID;
    const components = Array.isArray(message.updateComponents.components) ? [...message.updateComponents.components] : [];
    return {
      version: A2UI_RENDERER_VERSION,
      updateComponents: {
        ...message.updateComponents,
        surfaceId,
        components: ensureRootComponent(components),
      },
    };
  }

  if (isRecord(message.updateDataModel)) {
    return {
      version: A2UI_RENDERER_VERSION,
      updateDataModel: {
        ...message.updateDataModel,
        surfaceId: readString(message.updateDataModel.surfaceId) || DEFAULT_SURFACE_ID,
        path: readString(message.updateDataModel.path) || "/",
        value: "value" in message.updateDataModel ? message.updateDataModel.value : message.updateDataModel.data,
      },
    };
  }

  if (isRecord(message.deleteSurface)) {
    return {
      version: A2UI_RENDERER_VERSION,
      deleteSurface: {
        ...message.deleteSurface,
        surfaceId: readString(message.deleteSurface.surfaceId) || DEFAULT_SURFACE_ID,
      },
    };
  }

  return undefined;
}

function ensureRenderableMessages(messages: RecordValue[]): RecordValue[] {
  if (messages.length === 0) {
    return [];
  }

  const surfaceIds = unique(messages.map(getSurfaceId).filter((id): id is string => Boolean(id)));
  const created = new Set(
    messages
      .map((message) => (isRecord(message.createSurface) ? readString(message.createSurface.surfaceId) : undefined))
      .filter((id): id is string => Boolean(id)),
  );
  const result: RecordValue[] = [];

  surfaceIds.forEach((surfaceId) => {
    if (!created.has(surfaceId)) {
      result.push(createSurfaceMessage(surfaceId));
    }
  });

  result.push(...messages);

  const hasComponents = new Set(
    result
      .map((message) => (isRecord(message.updateComponents) ? readString(message.updateComponents.surfaceId) : undefined))
      .filter((id): id is string => Boolean(id)),
  );

  surfaceIds.forEach((surfaceId) => {
    if (!hasComponents.has(surfaceId)) {
      result.push(fallbackComponentsMessage(surfaceId));
    }
  });

  return result;
}

function ensureRootComponent(components: unknown[]): unknown[] {
  const records = components.filter(isRecord);
  const hasRoot = records.some((component) => readString(component.id) === "root");

  if (hasRoot) {
    return components;
  }

  const childIds = records.map((component) => readString(component.id)).filter((id): id is string => Boolean(id));
  const fallbackTextId = "a2uiFallbackText";
  const next = [...components];

  if (childIds.length === 0) {
    next.push({
      id: fallbackTextId,
      component: "Text",
      text: "A2UI emitted data without a root component.",
      variant: "body",
    });
  }

  next.push({
    id: "root",
    component: "Column",
    children: childIds.length > 0 ? childIds : [fallbackTextId],
    align: "stretch",
  });

  return next;
}

function fallbackComponentsMessage(surfaceId: string): RecordValue {
  return {
    version: A2UI_RENDERER_VERSION,
    updateComponents: {
      surfaceId,
      components: ensureRootComponent([]),
    },
  };
}

function createSurfaceMessage(surfaceId: string): RecordValue {
  return {
    version: A2UI_RENDERER_VERSION,
    createSurface: {
      surfaceId,
      catalogId: A2UI_BASIC_CATALOG_ID,
    },
  };
}

function getSurfaceId(message: RecordValue): string | undefined {
  if (isRecord(message.createSurface)) {
    return readString(message.createSurface.surfaceId);
  }

  if (isRecord(message.updateComponents)) {
    return readString(message.updateComponents.surfaceId);
  }

  if (isRecord(message.updateDataModel)) {
    return readString(message.updateDataModel.surfaceId);
  }

  if (isRecord(message.deleteSurface)) {
    return readString(message.deleteSurface.surfaceId);
  }

  return undefined;
}

function isSupportedVersion(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }

  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.toLowerCase().replace(/^v/, "");
  return normalized === "0.9" || normalized === "0.9.1" || normalized === "1.0";
}

function isA2uiMessage(value: RecordValue): boolean {
  return (
    isRecord(value.createSurface) ||
    isRecord(value.updateComponents) ||
    isRecord(value.updateDataModel) ||
    isRecord(value.deleteSurface)
  );
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
