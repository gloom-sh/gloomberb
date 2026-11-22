import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ES2023_ARRAY_METHODS, es2023ArrayMethodsScript } from "./build-assets";

type Method = (typeof ES2023_ARRAY_METHODS)[number];
type Native = Record<Method, (this: unknown, ...args: unknown[]) => unknown>;

const typedArrayPrototype: object = Object.getPrototypeOf(Int8Array.prototype);
const targets = { array: Array.prototype, typed: typedArrayPrototype };
const natives = {} as Record<keyof typeof targets, Partial<Record<Method, PropertyDescriptor>>>;

function native(kind: keyof typeof targets): Native {
  return Object.fromEntries(
    Object.entries(natives[kind]).map(([name, descriptor]) => [name, descriptor.value]),
  ) as Native;
}

function outcome(run: () => unknown): { value: unknown } | { threw: unknown } {
  try {
    return { value: run() };
  } catch (error) {
    return { threw: (error as Error).constructor };
  }
}

/** Calls the polyfilled method and the engine's own on the same input, and expects the same result or the same error type. */
function expectSame(kind: keyof typeof targets, method: Method, input: ArrayLike<unknown>, ...args: unknown[]) {
  const expected = outcome(() => native(kind)[method]!.call(input, ...args));
  const actual = outcome(() => (input as unknown as Record<Method, (...a: unknown[]) => unknown>)[method](...args));
  expect(actual).toStrictEqual(expected);
}

beforeAll(async () => {
  for (const [kind, prototype] of Object.entries(targets) as [keyof typeof targets, object][]) {
    natives[kind] = {};
    for (const method of ES2023_ARRAY_METHODS) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
      if (!descriptor) continue;
      natives[kind][method] = descriptor;
      delete (prototype as Record<string, unknown>)[method];
    }
  }
  new Function(await es2023ArrayMethodsScript())();
});

afterAll(() => {
  for (const [kind, prototype] of Object.entries(targets) as [keyof typeof targets, object][]) {
    for (const [method, descriptor] of Object.entries(natives[kind])) Object.defineProperty(prototype, method, descriptor);
  }
});

describe("ES2023 array methods without native support", () => {
  test("installs every method like the engine does, hidden from for...in", () => {
    for (const method of ES2023_ARRAY_METHODS) {
      const installed = Object.getOwnPropertyDescriptor(Array.prototype, method);
      expect(installed).toMatchObject({ writable: true, enumerable: false, configurable: true });
      expect(installed?.value).not.toBe(natives.array[method]?.value);
    }
    const keys: string[] = [];
    for (const key in [10, 20]) keys.push(key);
    expect(keys).toEqual(["0", "1"]);
  });

  test("toSorted sorts a copy: stable, strings by default, undefined last, holes read as undefined", () => {
    const records = Array.from({ length: 60 }, (_, index) => ({ group: index % 4, index }));
    expectSame("array", "toSorted", records, (a: typeof records[0], b: typeof records[0]) => a.group - b.group);
    expectSame("array", "toSorted", [10, 9, undefined, 1, 2, "b", "a", null]);
    expectSame("array", "toSorted", [3, , 1]);
    expectSame("array", "toSorted", [2, 1], null);
    const source = [3, 1, 2];
    const sorted = source.toSorted((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3]);
    expect(source).toEqual([3, 1, 2]);
  });

  test("toReversed, toSpliced and with leave the source alone", () => {
    expectSame("array", "toReversed", [1, , 3]);
    for (const args of [[], [1], [1, undefined], [1, 1], [-1], [1, 0, "x", "y"], [10, 2, "z"], [-10, 1], [1, -5]]) {
      expectSame("array", "toSpliced", ["a", "b", "c"], ...args);
    }
    for (const index of [0, 2, -1, -3, 1.9, "1", undefined, NaN, 3, -4, Infinity, -Infinity]) {
      expectSame("array", "with", ["a", "b", "c"], index, "x");
    }
    const source = [1, 2, 3];
    source.toReversed();
    source.toSpliced(0, 1);
    source.with(0, 9);
    expect(source).toEqual([1, 2, 3]);
  });

  test("findLast and findLastIndex visit from the end with the same arguments", () => {
    for (const method of ["findLast", "findLastIndex"] as const) {
      const run = (kind: "native" | "polyfill") => {
        const calls: unknown[][] = [];
        const list = [5, , 7, 8];
        const context = {};
        const predicate = function (this: unknown, value: unknown, index: number, array: unknown) {
          calls.push([this === context, value, index, array === list]);
          return value === undefined;
        };
        const result = kind === "native"
          ? native("array")[method]!.call(list, predicate, context)
          : list[method](predicate, context);
        return { result, calls };
      };
      expect(run("polyfill")).toStrictEqual(run("native"));
    }
    expectSame("array", "findLast", [1, 2, 3], (value: number) => value > 5);
    expectSame("array", "findLastIndex", [1, 2, 3], (value: number) => value > 5);
    expectSame("array", "findLast", [], undefined);
    expectSame("array", "findLastIndex", [], "nope");
  });

  describe.each([
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
  ])("%p", (TypedArray) => {
    const input = TypedArray.of(10, 9, 1, 2, 100, 3);

    test("toSorted compares numbers by default and returns the same type", () => {
      expectSame("typed", "toSorted", input);
      expectSame("typed", "toSorted", input, (a: number, b: number) => b - a);
      const sorted = input.toSorted();
      expect(sorted).toBeInstanceOf(TypedArray);
      expect(sorted).not.toBe(input);
      expect(Array.from(input)).toEqual([10, 9, 1, 2, 100, 3]);
    });

    test("toReversed, with, findLast and findLastIndex match", () => {
      expectSame("typed", "toReversed", input);
      for (const index of [0, -1, 5, -6, 6, -7, NaN]) expectSame("typed", "with", input, index, 300);
      expectSame("typed", "findLast", input, (value: number) => value < 5);
      expectSame("typed", "findLastIndex", input, (value: number) => value < 5);
      expectSame("typed", "findLast", input, (value: number) => value > 1000);
    });
  });

  test("Float64Array sorts NaN last and -0 before 0, as the engine does", () => {
    expectSame("typed", "toSorted", Float64Array.of(NaN, 0, -0, -1, Infinity, -Infinity));
  });

  test("BigInt64Array sorts as numbers", () => {
    expectSame("typed", "toSorted", BigInt64Array.of(10n, 9n, -1n, 2n));
    expectSame("typed", "with", BigInt64Array.of(1n, 2n), 1, 7n);
  });

  test("an engine that has a method keeps its own", async () => {
    const keep = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted")!;
    const stand = () => "native";
    Object.defineProperty(Array.prototype, "toSorted", { ...keep, value: stand });
    new Function(await es2023ArrayMethodsScript())();
    expect(Array.prototype.toSorted).toBe(stand as never);
    Object.defineProperty(Array.prototype, "toSorted", keep);
  });
});
