import { afterEach, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { attachRiskFactorsPersistence, resetRiskFactorsPersistence, loadRiskReportsWithClient, loadRiskReportWithClient } from "./data";
import { list, report } from "./test-fixtures";

afterEach(resetRiskFactorsPersistence);
const options={sourceKey:"risk-factors",schemaVersion:1};
function client(){return {getRiskReports:async()=>list([2026]),getRiskReport:async(_ticker:string,year:number)=>report(year)};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

test("failed forced discovery retains its original timestamp and retries on reopen before normal cache TTL",async()=>{
 const store=new MemoryPluginPersistence();attachRiskFactorsPersistence(store);store.seedResource("reports","CONTROL",list([2025]),options);
 const fetchedAt=store.getResource("reports","CONTROL",options)!.fetchedAt;const api=client();let calls=0;let unavailable=true;
 api.getRiskReports=async()=>{calls++;if(unavailable)throw new ApiRequestError("Discovery unavailable",503);return list([2026,2025]);};
 const stale=await loadRiskReportsWithClient(api,"CONTROL",{force:true});expect(stale).toMatchObject({fetchedAt,stale:true,refreshError:"Discovery unavailable",errorStatus:503});
 expect((await loadRiskReportsWithClient(api,"CONTROL")).stale).toBe(true);expect(calls).toBe(2);
 unavailable=false;expect((await loadRiskReportsWithClient(api,"CONTROL")).reports[0]?.reportYear).toBe(2026);
 expect((await loadRiskReportsWithClient(api,"CONTROL")).stale).toBe(false);expect(calls).toBe(3);
});

for(const status of [401,403,404])test(`report ${status} cannot fall back to cached content`,async()=>{
 const store=new MemoryPluginPersistence();attachRiskFactorsPersistence(store);store.seedResource("report","CONTROL:2025",report(2025),{...options,stale:true});
 const api=client();api.getRiskReport=async()=>{throw new ApiRequestError("Report unavailable",status);};
 await expect(loadRiskReportWithClient(api,"CONTROL",2025)).rejects.toMatchObject({status});expect(store.getResource("report","CONTROL:2025",{...options,allowExpired:true})).toBeNull();
});

test("a list 404 is an empty cached list",async()=>{
 const store=new MemoryPluginPersistence();attachRiskFactorsPersistence(store);const api=client();let calls=0;
 api.getRiskReports=async()=>{calls++;throw new ApiRequestError("No risk factor reports for this ticker",404);};
 await expect(loadRiskReportsWithClient(api,"CONTROL")).resolves.toMatchObject({reports:[],stale:false});
 await loadRiskReportsWithClient(api,"CONTROL");expect(calls).toBe(1);expect(store.getResource("reports","CONTROL",options)?.value).toMatchObject({reports:[]});
});

test("transient historical refresh retains immutable source dates and expired content",async()=>{
 const store=new MemoryPluginPersistence();attachRiskFactorsPersistence(store);store.seedResource("report","CONTROL:2025",report(2025),{...options,stale:true,expired:true});
 const before=store.getResource("report","CONTROL:2025",{...options,allowExpired:true})!;const api=client();api.getRiskReport=async()=>{throw new ApiRequestError("Temporary outage",503);};
 const result=await loadRiskReportWithClient(api,"CONTROL",2025);expect(result).toMatchObject({reportYear:2025,filedAt:report(2025).filedAt,updatedAt:report(2025).updatedAt,docUrl:report(2025).docUrl,fetchedAt:before.fetchedAt,stale:true,refreshError:"Temporary outage"});
});

test("late discovery cannot rewind forced refresh persistence",async()=>{
 const store=new MemoryPluginPersistence();attachRiskFactorsPersistence(store);const old=deferred<ReturnType<typeof list>>();const api=client();let calls=0;
 api.getRiskReports=()=>++calls===1?old.promise:Promise.resolve(list([2026,2025]));
 const first=loadRiskReportsWithClient(api,"CONTROL");expect(loadRiskReportsWithClient(api,"CONTROL")).toBe(first);
 await loadRiskReportsWithClient(api,"CONTROL",{force:true});old.resolve(list([2025]));await first;
 expect((await loadRiskReportsWithClient(api,"CONTROL")).reports.map(r=>r.reportYear)).toEqual([2026,2025]);expect(calls).toBe(2);
});

test("a request from the previous persistence lifetime cannot write into its replacement",async()=>{
 const firstStore=new MemoryPluginPersistence();const nextStore=new MemoryPluginPersistence();attachRiskFactorsPersistence(firstStore);const pending=deferred<ReturnType<typeof list>>();const api=client();api.getRiskReports=()=>pending.promise;
 const first=loadRiskReportsWithClient(api,"CONTROL");await Promise.resolve();resetRiskFactorsPersistence();attachRiskFactorsPersistence(nextStore);pending.resolve(list([2025]));await first;
 expect(firstStore.getResource("reports","CONTROL",options)).toBeNull();expect(nextStore.getResource("reports","CONTROL",options)).toBeNull();
});

test("a report response for another ticker or year cannot be cached under the requested filing",async()=>{
 const store=new MemoryPluginPersistence();attachRiskFactorsPersistence(store);const api=client();api.getRiskReport=async()=>report(2026);
 await expect(loadRiskReportWithClient(api,"CONTROL",2025)).rejects.toThrow("does not match CONTROL 2025");
 expect(store.getResource("report","CONTROL:2025",options)).toBeNull();api.getRiskReport=async()=>({...report(2025),ticker:"OTHER"});
 await expect(loadRiskReportWithClient(api,"CONTROL",2025)).rejects.toThrow("does not match CONTROL 2025");
 // The server spells share classes the SEC way; BRK.B and BRK-B are one filer.
 api.getRiskReport=async()=>({...report(2025),ticker:"BRK-B"});
 await expect(loadRiskReportWithClient(api,"BRK.B",2025)).resolves.toMatchObject({ticker:"BRK-B"});
});
