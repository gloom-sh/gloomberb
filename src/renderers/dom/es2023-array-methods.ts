// The ES2023 array methods for browsers before Chrome 110 and Firefox 115. Built onto the top of each web page's bundle (es2023ArrayMethodsScript), so it needs no exports.

type Indexed = { length: number; [index: number]: unknown };
type Predicate = (value: unknown, index: number, list: Indexed) => unknown;

// defineProperty, not assignment: natives are not enumerable, and `for...in` over an array must not see these.
function define(target: object, name: string, value: (this: any, ...args: any[]) => unknown): void {
  if (typeof (target as Record<string, unknown>)[name] === "function") return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true });
}

function requirePredicate(predicate: unknown): asserts predicate is Predicate {
  if (typeof predicate !== "function") throw new TypeError(`${String(predicate)} is not a function`);
}

function installShared(target: object, copy: (list: Indexed) => any): void {
  define(target, "toSorted", function (compare) {
    return copy(this).sort(compare);
  });
  define(target, "toReversed", function () {
    return copy(this).reverse();
  });
  define(target, "with", function (index, value) {
    const length = this.length;
    const integer = Math.trunc(Number(index)) || 0;
    const at = integer < 0 ? length + integer : integer;
    if (at < 0 || at >= length) throw new RangeError(`Invalid index: ${String(index)}`);
    const result = copy(this);
    result[at] = value;
    return result;
  });
  define(target, "findLast", function (predicate, thisArg) {
    requirePredicate(predicate);
    for (let index = this.length - 1; index >= 0; index--) {
      const value = this[index];
      if (predicate.call(thisArg, value, index, this)) return value;
    }
    return undefined;
  });
  define(target, "findLastIndex", function (predicate, thisArg) {
    requirePredicate(predicate);
    for (let index = this.length - 1; index >= 0; index--) {
      if (predicate.call(thisArg, this[index], index, this)) return index;
    }
    return -1;
  });
}

const copyArray = (list: Indexed) => Array.from(list);
installShared(Array.prototype, copyArray);
define(Array.prototype, "toSpliced", function (...args: Parameters<unknown[]["splice"]>) {
  const result = copyArray(this);
  result.splice(...args);
  return result;
});
// The typed arrays share one prototype, and `slice` keeps the element type.
installShared(Object.getPrototypeOf(Int8Array.prototype), (list) => (list as Uint8Array).slice());
