import {afterAll,afterEach,expect,test} from "bun:test";
import {act,useEffect,useMemo,useState} from "react";
import {writeFileSync} from "node:fs";
import {report,list} from "./test-fixtures";
const source=new URL("../../../../",import.meta.url).pathname.replace(/\/$/,"");
const out=process.env.RISK_OUT;
const rawFetch=globalThis.fetch;const RawSocket=globalThis.WebSocket;const external:string[]=[];const sockets:string[]=[];
globalThis.fetch=(async(input:any,init:any)=>{const url=String(input instanceof Request?input.url:input);if(url.startsWith("data:"))return rawFetch(input,init);external.push(url);throw new Error("External request blocked");}) as typeof fetch;
globalThis.WebSocket=class {constructor(url:unknown){sockets.push(String(url));throw new Error("External socket blocked");}} as unknown as typeof WebSocket;
const {apiClient,setCloudApiFetchTransport}=await import(`${source}/src/api-client`);
const {RiskFactorsPane}=await import(`${source}/src/plugins/builtin/risk-factors/pane`);
const {attachRiskFactorsPersistence,resetRiskFactorsPersistence}=await import(`${source}/src/plugins/builtin/risk-factors/data`);
const {MemoryPluginPersistence}=await import(`${source}/src/test-support/plugin-persistence`);
const {PaneFooterProvider,PaneFooterBar}=await import(`${source}/src/components/layout/pane/footer`);
const {appReducer,createInitialState}=await import(`${source}/src/state/app/context`);
const {createTestPaneConfig,TestPaneProvider,createTestTicker}=await import(`${source}/src/test-support/pane`);
const {createStatefulTestPluginRuntime}=await import(`${source}/src/test-support/plugin-runtime`);
const {testRender}=await import(`${source}/src/renderers/opentui/test-utils`);
const {Box,useRendererHost}=await import(`${source}/src/ui`);
let setup:any;let requests:string[]=[];let opened:string[]=[];let selectTicker:(symbol:string)=>void;const cases:any[]=[];
// The chosen filing year is pane state, so the harness needs a reducer.
function Harness(){const [symbol,setSymbol]=useState("CONTROL");selectTicker=setSymbol;const [paneState,setPaneState]=useState<any>({});const state=useMemo(()=>{const config=createTestPaneConfig("/tmp/unused-risk-report",{instanceId:"risk:audit",paneId:"risk-factors",binding:{kind:"fixed",symbol}});const state=createInitialState(config);state.tickers=new Map([[symbol,createTestTicker(symbol)]]);state.focusedPaneId="risk:audit";return state;},[symbol]);state.paneState=paneState;const dispatch=(action:any)=>setPaneState((current:any)=>appReducer({...state,paneState:current},action).paneState);const runtime=useMemo(()=>createStatefulTestPluginRuntime(),[]);const host=useRendererHost();useEffect(()=>{const original=host.openExternal;host.openExternal=async(url:string)=>{opened.push(url);};return()=>{host.openExternal=original;};},[host]);return <TestPaneProvider state={state} dispatch={dispatch} paneId="risk:audit" pluginId="ticker-research" runtime={runtime}><PaneFooterProvider>{(footer:any)=><Box width={100} height={24} flexDirection="column"><Box height={23}><RiskFactorsPane focused width={100} height={23}/></Box><PaneFooterBar footer={footer} focused width={100}/></Box>}</PaneFooterProvider></TestPaneProvider>;}
async function settle(){for(let i=0;i<8;i++)await act(async()=>{await Bun.sleep(5);await setup.renderOnce();});}
async function mount(){await act(async()=>{setup=await testRender(<Harness/>,{width:100,height:24});});await settle();}
function capture(name:string){const frame=setup.captureCharFrame();if(out)writeFileSync(`${out}/${name}.txt`,frame);return frame;}
function transport(fn:(url:string)=>Promise<Response>|Response){setCloudApiFetchTransport((async(input:any)=>{const path=new URL(String(input)).pathname;requests.push(path);return fn(path);}) as typeof fetch);}
async function click(label:string){await act(async()=>{await Bun.sleep(170);});await settle();const rows=setup.captureCharFrame().split("\n");const y=rows.findIndex((row:string)=>row.includes(label));expect(y).toBeGreaterThanOrEqual(0);await act(async()=>setup.mockMouse.click(rows[y].indexOf(label)+2,y));await settle();}
async function key(value:string){await act(async()=>setup.mockInput.pressKey(value));await settle();}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
afterEach(async()=>{if(setup)await act(async()=>setup.renderer.destroy());setup=null;resetRiskFactorsPersistence();setCloudApiFetchTransport(null);apiClient.dispose();requests=[];opened=[];});
afterAll(()=>{if(out)writeFileSync(`${out}/observations.json`,JSON.stringify({source,cases,external,sockets},null,2));globalThis.fetch=rawFetch;globalThis.WebSocket=RawSocket;if(external.length||sockets.length)throw new Error("Unexpected external attempt");});
test("stale discovery is disclosed; standard refresh follows latest until an explicit historical selection",async()=>{
 const store=new MemoryPluginPersistence();store.seedResource("reports","CONTROL",list([2025]),{sourceKey:"risk-factors",schemaVersion:1,stale:true});store.seedResource("report","CONTROL:2025",report(2025),{sourceKey:"risk-factors",schemaVersion:1});attachRiskFactorsPersistence(store);
 let newest=2026;let unavailable=true;transport(path=>path.endsWith("/CONTROL")?unavailable?new Response("Discovery unavailable",{status:503}):Response.json(list([...new Set([2025,newest,2026])])):Response.json(report(Number(path.split("/").at(-1)))));
 await mount();const stale=capture("stale-discovery");expect(stale).toContain("Only 2025 risk analysis");expect(stale).toContain("Discovery unavailable");
 unavailable=false;await key("r");const latest=capture("discovery-recovered");expect(latest).toContain("Only 2026 risk analysis");expect(latest).toContain("Filed 2026-02-03");expect(latest).toContain("updated 2026-02-04");expect(latest).not.toContain("Discovery unavailable");
 await click("2025 10-K");newest=2027;await key("r");const historical=capture("historical-preserved");expect(historical).toContain("2027 10-K");expect(historical).toContain("Only 2025 risk analysis");expect(historical).not.toContain("Only 2027 risk analysis");await click("[o]pen filing");expect(opened.at(-1)).toBe(report(2025).docUrl);cases.push({case:"discovery-refresh-and-historical-choice",requests:[...requests],opened:[...opened]});
});
test("historical year loading and failure cannot display the previous report or its filing action",async()=>{
 const pending=deferred<Response>();let recovery=false;transport(path=>path.endsWith("/CONTROL")?Response.json(list([2026,2025])):path.endsWith("/2026")?Response.json(report(2026)):recovery?Response.json(report(2025)):pending.promise);
 await mount();capture("year-current");await click("2025 10-K");const loading=capture("year-loading");expect(loading).not.toContain("Only 2026 risk analysis");await key("o");expect(opened).toEqual([]);
 pending.resolve(new Response("Historical report unavailable",{status:503}));await settle();const failed=capture("year-failed");expect(failed).toContain("Historical report unavailable");expect(failed).not.toContain("Only 2026 risk analysis");expect(failed).not.toContain("Loading...");recovery=true;await key("r");const recovered=capture("year-recovered");expect(recovered).toContain("Only 2025 risk analysis");await click("[o]pen filing");expect(opened.at(-1)).toBe(report(2025).docUrl);cases.push({case:"historical-failure-recovery",requests:[...requests],opened:[...opened]});
});
for(const status of [503,404])test(`initial report ${status} stops loading and exposes the cause`,async()=>{
 transport(path=>path.endsWith("/CONTROL")?Response.json(list([2026])):new Response("Detail unavailable",{status}));await mount();const failed=capture(`initial-detail-${status}`);expect(failed).toContain("Detail unavailable");expect(failed).not.toContain("Loading...");expect(failed).not.toContain("[o]pen filing");cases.push({case:`initial-detail-${status}`,requests:[...requests]});
});
test("changing ticker while a historical report is pending cannot adopt the old security or year",async()=>{
 const pending=deferred<Response>();transport(path=>path.endsWith("/CONTROL")?Response.json(list([2026,2025])):path.endsWith("/CONTROL/2025")?pending.promise:path.endsWith("/CONTROL/2026")?Response.json(report(2026)):path.endsWith("/OTHER")?Response.json({...list([2024]),company:{...list([2024]).company,ticker:"OTHER"}}):Response.json({...report(2024),ticker:"OTHER",docUrl:"https://www.sec.gov/Archives/other-2024.htm",overview:"Only OTHER 2024 risk analysis"}));
 await mount();await click("2025 10-K");await act(async()=>selectTicker("OTHER"));await settle();const next=capture("ticker-changed");expect(next).toContain("Only OTHER 2024 risk analysis");expect(requests).not.toContain("/public/risks/OTHER/2025");pending.resolve(Response.json(report(2025)));await settle();const completed=capture("ticker-old-completion");expect(completed).toContain("Only OTHER 2024 risk analysis");expect(completed).not.toContain("Only 2025 risk analysis");await click("[o]pen filing");expect(opened.at(-1)).toBe("https://www.sec.gov/Archives/other-2024.htm");cases.push({case:"ticker-ownership",requests:[...requests],opened:[...opened]});
});
test("in-memory report survives transient refresh with its source dates but clears after definitive denial",async()=>{
 let status=200;transport(path=>path.endsWith("/CONTROL")?Response.json(list([2026])):status===200?Response.json(report(2026)):new Response(status===503?"Temporary report outage":"Access denied",{status}));await mount();capture("memory-initial");status=503;await key("r");const failed=capture("memory-transient");expect(failed).toContain("Only 2026 risk analysis");expect(failed).toContain("Temporary report outage");expect(failed).toContain("Filed 2026-02-03");status=403;await key("r");const denied=capture("memory-denied");expect(denied).not.toContain("Only 2026 risk analysis");expect(denied).toContain("Access denied");expect(denied).not.toContain("[o]pen filing");cases.push({case:"memory-retention-and-denial",requests:[...requests]});
});
