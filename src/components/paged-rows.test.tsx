import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { MemoryResourceStore } from "../data/memory-resource-store";
import { readSavedCopy, setSavedCopyStore, writeSavedCopy } from "../data/pane-saved-copies";
import { usePagedRows, type PageLoader, type PageRequest, type RowPage } from "./paged-rows";

type Page = RowPage<string>;
const tui = createOpenTuiTestHarness();
let paged: ReturnType<typeof usePagedRows<Page>>;
let changeLoader: (next: PageLoader<Page> | null) => void;

async function mount(loader: PageLoader<Page> | null, options: { keepPreviousRows?: boolean } = {}) {
  function Probe() {
    const [request, setRequest] = useState(() => loader);
    changeLoader = (next) => setRequest(() => next);
    paged = usePagedRows(request, { getId: (row) => row, ...options });
    return null;
  }
  await tui.render(<Probe />, { width: 20, height: 5 });
  await act(async () => { await tui.setup().renderOnce(); });
}

/** A loader whose every request waits for the test to answer it. */
function deferredLoader() {
  const requests: (PageRequest & { answer: Promise<Page>; resolve: (page: Page) => void; reject: (error: Error) => void })[] = [];
  const load: PageLoader<Page> = (request) => {
    const { promise, resolve, reject } = Promise.withResolvers<Page>();
    requests.push({ ...request, answer: promise, resolve, reject });
    return promise;
  };
  return { load, requests };
}

test("pages append from the answered offset, skip repeated rows, and a failed page is asked again", async () => {
  const source = deferredLoader();
  await mount(source.load);
  await act(async () => { source.requests[0]!.resolve({ rows: ["a", "b"], hasMore: true, nextOffset: 50 }); });

  await act(async () => { paged.loadMore(); paged.loadMore(); });
  expect(source.requests.map((request) => request.offset)).toEqual([0, 50]);
  await act(async () => { source.requests[1]!.reject(new Error("page down")); });
  expect(paged).toMatchObject({ rows: ["a", "b"], hasMore: true, loadingMore: false, error: null });
  expect(paged.moreError?.message).toBe("page down");

  await act(async () => { paged.loadMore(); });
  expect(source.requests[2]!.offset).toBe(50);
  await act(async () => { source.requests[2]!.resolve({ rows: ["b", "c"], hasMore: false }); });
  expect(paged).toMatchObject({ rows: ["a", "b", "c"], hasMore: false, moreError: null, status: "loaded" });
  expect(paged.pages).toHaveLength(2);
});

test("a new loader aborts and ignores the old one's pages and starts from an empty list", async () => {
  const first = deferredLoader();
  await mount(first.load);
  await act(async () => { first.requests[0]!.resolve({ rows: ["old"], hasMore: true }); });
  await act(async () => { paged.loadMore(); });

  const second = deferredLoader();
  await act(async () => { changeLoader(second.load); });
  expect(first.requests[1]!.signal.aborted).toBe(true);
  expect(paged).toMatchObject({ rows: [], loading: true, status: "loading" });
  await act(async () => { first.requests[1]!.resolve({ rows: ["stale"], hasMore: false }); });
  expect(paged.rows).toEqual([]);

  await act(async () => { second.requests[0]!.resolve({ rows: ["new"] }); });
  expect(paged).toMatchObject({ rows: ["new"], hasMore: false, status: "loaded" });

  await act(async () => { changeLoader(null); });
  expect(paged).toMatchObject({ rows: [], loading: false, status: "idle" });
});

test("a reload keeps its rows until it answers and through a failure, and stops paging after one", async () => {
  const source = deferredLoader();
  await mount(source.load);
  await act(async () => { source.requests[0]!.resolve({ rows: ["a"], hasMore: true }); });

  // A scroll in the same tick as the reload must not page the list being replaced.
  await act(async () => { paged.reload(); paged.loadMore(); });
  expect(source.requests).toHaveLength(2);
  expect(source.requests[1]!.force).toBe(true);
  expect(paged).toMatchObject({ rows: ["a"], loading: true, status: "loaded" });

  await act(async () => { source.requests[1]!.reject(new Error("offline")); });
  expect(paged).toMatchObject({ rows: ["a"], loading: false, hasMore: false, status: "error" });
  expect(paged.error?.message).toBe("offline");
});

test("keepPreviousRows shows the last answer while a new query loads, and nothing once it fails", async () => {
  const first = deferredLoader();
  await mount(first.load, { keepPreviousRows: true });
  await act(async () => { first.requests[0]!.resolve({ rows: ["apple"], hasMore: true }); });

  const second = deferredLoader();
  await act(async () => { changeLoader(second.load); });
  expect(paged).toMatchObject({ rows: ["apple"], loading: true, hasMore: false, status: "loading" });
  await act(async () => { second.requests[0]!.reject(new Error("bad query")); });
  expect(paged).toMatchObject({ rows: [], loading: false, status: "error" });
});

test("a new page key uses its own saved rows or keeps the previous rows without delaying a miss", async () => {
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const source = deferredLoader();
  let search!: (query: string) => void;
  function Probe() {
    const [query, setQuery] = useState("first");
    search = setQuery;
    paged = usePagedRows(source.load, { keepPreviousRows: true, savedCopy: { key: ["search-page", query] } });
    return null;
  }
  try {
    writeSavedCopy({ key: ["search-page", "first"] }, { rows: ["first saved rows"] });
    writeSavedCopy({ key: ["search-page", "second"] }, { rows: ["second saved rows"] });
    await tui.render(<Probe />);
    expect(paged.rows).toEqual(["first saved rows"]);
    await act(async () => { search("second"); });
    expect(paged.rows).toEqual(["second saved rows"]);
    await act(async () => { search("third"); });
    expect(paged.rows).toEqual(["second saved rows"]);
    const request = source.requests.at(-1)!;
    expect(request.signal.aborted).toBe(false);
    await act(async () => { request.resolve({ rows: ["live rows"] }); });
    expect(paged.rows).toEqual(["live rows"]);
  } finally {
    setSavedCopyStore(previous);
  }
});

test("a first page with runtime work opens from its display snapshot while the next page request is pending", async () => {
  type LivePage = Page & { detailsLoaded?: Promise<void> };
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const key = { key: ["table", "first request"] };
  const read = Promise.withResolvers<LivePage>();
  const load: PageLoader<LivePage> = () => read.promise;
  let view: ReturnType<typeof usePagedRows<LivePage>> | undefined;
  function Probe({ loader }: { loader: PageLoader<LivePage> }) {
    view = usePagedRows(loader, { savedCopy: key, snapshotPage: ({ rows, hasMore }) => ({ rows, hasMore }) });
    return null;
  }
  try {
    await tui.render(<Probe loader={load} />);
    await act(async () => { read.resolve({ rows: ["saved row"], detailsLoaded: Promise.resolve() }); });
    expect(readSavedCopy(key)?.value).toEqual({ rows: ["saved row"] });

    await tui.destroy();
    const refresh = Promise.withResolvers<LivePage>();
    await tui.render(<Probe loader={() => refresh.promise} />);
    expect(view).toMatchObject({ rows: ["saved row"], loading: false, refreshing: true });
    await act(async () => { refresh.resolve({ rows: ["live row"] }); });
    expect(view).toMatchObject({ rows: ["live row"], loading: false, refreshing: false });
  } finally {
    setSavedCopyStore(previous);
  }
});
