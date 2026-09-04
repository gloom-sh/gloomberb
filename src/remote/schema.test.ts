import { describe, expect, test } from "bun:test";
import {
  REMOTE_OPERATIONS,
  remoteOperationDescriptors,
  writeTierForSideEffectLevel,
} from "./schema";

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("remote operation schema", () => {
  test("publishes stable input schemas and write tiers", () => {
    expect(REMOTE_OPERATIONS.length).toBeGreaterThan(0);

    for (const operation of REMOTE_OPERATIONS) {
      expect(operation.title.length).toBeGreaterThan(0);
      expect(operation.inputSchema.type).toBe("object");
      const mappedTier = writeTierForSideEffectLevel(operation.sideEffectLevel);
      if (operation.id === "layout.delete") {
        expect(operation.sideEffectLevel).toBe("local-write");
        expect(operation.writeTier).toBe("user-data");
      } else {
        expect(operation.writeTier).toBe(mappedTier);
      }
      expect(jsonRoundTrip(operation.inputSchema)).toEqual(operation.inputSchema);
    }

    expect(writeTierForSideEffectLevel("none")).toBe("read");
    expect(writeTierForSideEffectLevel("network-write")).toBe("user-data");
    expect(writeTierForSideEffectLevel("external-trade")).toBe("broker");
    expect(REMOTE_OPERATIONS.find(({ id }) => id === "layout.delete")?.writeTier)
      .toBe("user-data");
    expect(REMOTE_OPERATIONS.find(({ id }) => id === "capability.invoke")?.writeTier)
      .toBe("broker");
    expect(REMOTE_OPERATIONS.find(({ id }) => id === "layout.placePane")?.inputSchema)
      .toMatchObject({
        required: ["paneId", "region"],
        properties: {
          region: { enum: ["left", "right", "top", "bottom", "floating"] },
        },
      });
  });

  test("serializes operation descriptors without losing fields", () => {
    const descriptors = remoteOperationDescriptors();

    expect(jsonRoundTrip(descriptors)).toEqual(descriptors);
    expect(descriptors).toHaveLength(REMOTE_OPERATIONS.length);
    expect(descriptors[0]).toEqual({
      name: REMOTE_OPERATIONS[0]!.id,
      title: REMOTE_OPERATIONS[0]!.title,
      description: REMOTE_OPERATIONS[0]!.description,
      writeTier: REMOTE_OPERATIONS[0]!.writeTier,
      inputSchema: REMOTE_OPERATIONS[0]!.inputSchema,
    });
  });
});
