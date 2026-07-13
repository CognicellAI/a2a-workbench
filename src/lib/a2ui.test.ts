import { describe, expect, it } from "vitest";
import { A2UI_BASIC_CATALOG_ID, extractFencedA2uiBlocks, normalizeA2uiPayload } from "@/lib/a2ui";

describe("A2UI normalization", () => {
  it("flattens message wrappers and JSON strings", () => {
    const normalized = normalizeA2uiPayload(
      JSON.stringify({
        messages: [
          {
            version: "v0.9.1",
            createSurface: { surfaceId: "s1", catalogId: "old" },
          },
        ],
      }),
    );

    expect(normalized).toEqual([
      {
        version: "v0.9",
        createSurface: {
          surfaceId: "s1",
          catalogId: A2UI_BASIC_CATALOG_ID,
        },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "s1",
          components: [
            {
              id: "a2uiFallbackText",
              component: "Text",
              text: "A2UI emitted data without a root component.",
              variant: "body",
            },
            {
              id: "root",
              component: "Column",
              children: ["a2uiFallbackText"],
              align: "stretch",
            },
          ],
        },
      },
    ]);
  });

  it("adds a createSurface message when only updates arrive", () => {
    const normalized = normalizeA2uiPayload({
      version: "v0.9",
      updateComponents: {
        surfaceId: "surface-a",
        components: [{ id: "title", component: "Text", text: "Ready" }],
      },
    });

    expect(normalized).toEqual([
      {
        version: "v0.9",
        createSurface: {
          surfaceId: "surface-a",
          catalogId: A2UI_BASIC_CATALOG_ID,
        },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "surface-a",
          components: [
            { id: "title", component: "Text", text: "Ready" },
            {
              id: "root",
              component: "Column",
              children: ["title"],
              align: "stretch",
            },
          ],
        },
      },
    ]);
  });

  it("copies updateDataModel data into value and defaults the path", () => {
    expect(
      normalizeA2uiPayload({
        version: "v1.0",
        updateDataModel: {
          surfaceId: "s2",
          data: { score: 7 },
        },
      }),
    ).toContainEqual({
      version: "v0.9",
      updateDataModel: {
        surfaceId: "s2",
        path: "/",
        value: { score: 7 },
        data: { score: 7 },
      },
    });
  });

  it("drops unsupported v0.8 messages", () => {
    expect(
      normalizeA2uiPayload({
        version: "v0.8",
        updateComponents: {
          components: [{ id: "root", component: "Text", text: "Old" }],
        },
      }),
    ).toEqual([]);
  });

  it("extracts legacy fenced blocks", () => {
    expect(
      extractFencedA2uiBlocks("before\n```a2ui\n{\"messages\":[]}\n```\nafter"),
    ).toEqual([{ messages: [] }]);
  });
});
