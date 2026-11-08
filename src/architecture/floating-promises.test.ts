import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import ts from "typescript";
import {
  compareFloatingPromises, floatingPromiseProgram, formatFloatingPromiseAllowlist, scanFloatingPromises,
  type FloatingPromise,
} from "../../scripts/update-floating-promise-allowlist";

const ROOT = resolve(import.meta.dir, "../..");

function scan(text: string): Array<[number, FloatingPromise["kind"], string]> {
  const path = join(ROOT, "src/floating-promise-example.ts");
  const host = ts.createCompilerHost({});
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, language, ...rest) => name === path
    ? ts.createSourceFile(name, text, language, true) : getSourceFile.call(host, name, language, ...rest);
  host.fileExists = (name) => name === path || fileExists.call(host, name);
  host.readFile = (name) => name === path ? text : readFile.call(host, name);
  return scanFloatingPromises(floatingPromiseProgram(ROOT, [path], host), [path], ROOT)
    .map((site) => [site.line, site.kind, site.label]);
}

const DECLARATIONS = `
  declare function save(): Promise<void>;
  declare function sync(): void;
  declare function maybe(): void | Promise<void>;
  declare function handoff(): void | PromiseLike<void>;
  declare function own(promise: Promise<unknown>): void;
  declare function later(run: () => void): void;
  declare function wait(run: () => void | Promise<void>): void;
  declare const store: { save?: () => Promise<void> };
  declare const flag: boolean;
  declare const untyped: any;
`;

test("unhandled promises are found and handled ones pass", async () => {
  const sites = scan(`${DECLARATIONS}
    save();
    void save();
    save().then(sync);
    save().then(sync, undefined);
    save().finally(sync);
    flag ? save() : sync();
    flag && save();
    maybe();
    store.save?.();
    (async () => { await save(); })();
    Promise.all([save()]);
    [1].map(() => save());
    void (flag ? sync() : save());
    later(() => save());
    later(() => void save());
    [1].forEach(() => save());
    save().catch(sync);
    void save().catch(sync);
    save().then(sync, sync);
    save().catch(sync).finally(sync);
    handoff();
    own(save());
    const pending = save();
    let stored; stored = save();
    Promise.allSettled([save()]);
    untyped.save();
    later(() => sync());
    wait(() => save());
    later(async () => { await save(); });
    async function run() { await save(); await Promise.all([save()]); return save(); }
    [1].map(() => save()).length;
    save().then(() => save());
  `);
  expect(sites).toEqual([
    [13, "statement", "save()"],
    [14, "void", "save()"],
    [15, "statement", "save().then()"],
    [16, "statement", "save().then()"],
    [17, "statement", "save().finally()"],
    [18, "statement", "save()"],
    [19, "statement", "save()"],
    [20, "statement", "maybe()"],
    [21, "statement", "store.save()"],
    [22, "statement", "function()"],
    [23, "statement", "Promise.all()"],
    [24, "statement", "expression.map()"],
    [25, "void", "save()"],
    [26, "callback", "save()"],
    [27, "void", "save()"],
    [28, "callback", "save()"],
    [44, "statement", "save().then()"],
  ]);
});

test("the allowlist counts each site once and reports new, stale and unsorted entries", () => {
  const site = (file: string, label: string, kind: FloatingPromise["kind"] = "void"): FloatingPromise =>
    ({ file, line: 1, column: 1, kind, label, scope: "in", code: `void ${label}` });
  const allowlist = { "src/a.ts": ["void:load()", "void:load()"], "src/b.ts": ["statement:save()"] };
  const text = formatFloatingPromiseAllowlist(allowlist);
  expect(compareFloatingPromises([site("src/a.ts", "load()"), site("src/a.ts", "load()"),
    site("src/b.ts", "save()", "statement"), { ...site("src/chat.ts", "send()"), scope: "out" }], text)).toEqual([]);
  const [added, stale] = compareFloatingPromises([site("src/a.ts", "load()"), site("src/a.ts", "load()"), site("src/a.ts", "load()")], text);
  expect(added).toContain("src/a.ts:1:1 void:load()");
  expect(stale).toContain("src/b.ts statement:save()");
  expect(compareFloatingPromises([site("src/b.ts", "save()", "statement"), site("src/a.ts", "load()"), site("src/a.ts", "load()")],
    JSON.stringify(allowlist))).toEqual([expect.stringContaining("out of order")]);
});
