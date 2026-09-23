import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { writeFileSync } from "node:fs";
const source=new URL("../../../../../",import.meta.url).pathname.replace(/\/$/,""); const out=process.env.FINANCIAL_OUT;
const {testRender,takeSavedTextFile}=await import(`${source}/src/renderers/opentui/test-utils.tsx`);
const {AppContext,PaneInstanceProvider,appReducer,createInitialState}=await import(`${source}/src/state/app/context`);
const {createTestPaneConfig,createTestTicker}=await import(`${source}/src/test-support/pane.tsx`);
const {PaneFooterProvider,PaneFooterBar}=await import(`${source}/src/components/layout/pane/footer`);
const {Box}=await import(`${source}/src/ui`);
const {FinancialsTab}=await import(`${source}/src/plugins/builtin/ticker-detail/financials/tab.tsx`);
const {financialStatementsHeadless}=await import(`${source}/src/plugins/builtin/ticker-detail/headless.ts`);
const {renderHeadlessPaneText,buildHeadlessFunctionReport}=await import(`${source}/src/cli/pane-functions/headless.ts`);
const {createTestDataProvider}=await import(`${source}/src/test-support/data-provider.ts`);
const {exportPaneTable}=await import(`${source}/src/state/pane-table-export-registry.ts`);
const paneId="financials:control";
async function cli(financials:any,period:string){
 const resolved={token:"FA",label:"Financial Analysis",headless:financialStatementsHeadless,options:{period,statement:"income"},instance:{settings:{}},capability:{id:"financial-statements"}};
 const context={config:createTestPaneConfig("/tmp/fundamental-cli-controlled",{instanceId:paneId,paneId:"financial-analysis",binding:{kind:"fixed",symbol:"CONTROL"}}),dataProvider:createTestDataProvider({getTickerFinancials:async()=>financials}),store:{loadTicker:async()=>null}};
 return buildHeadlessFunctionReport(resolved as any,context as any,"CONTROL");
}

let setup:any;
afterEach(async()=>{if(setup){await act(async()=>setup.renderer.destroy());setup=undefined;}});
async function mount(financials:any,period="annual"){
 const config=createTestPaneConfig("/tmp/fundamental-controlled",{instanceId:paneId,paneId:"financial-analysis",binding:{kind:"fixed",symbol:"CONTROL"}});
 const initial=createInitialState(config);initial.tickers=new Map([["CONTROL",createTestTicker("CONTROL")]]);initial.financials=new Map([["CONTROL",financials]]);initial.paneState[paneId]={financialPeriod:period,financialSubTab:"income"};
 function Harness(){const [state,dispatch]=useReducer(appReducer,initial);return <AppContext value={{state,dispatch}}><PaneInstanceProvider paneId={paneId}><PaneFooterProvider>{(footer:any)=><Box width={120} height={28} flexDirection="column"><Box height={27}><FinancialsTab width={120} focused/></Box><PaneFooterBar footer={footer} focused width={120}/></Box>}</PaneFooterProvider></PaneInstanceProvider></AppContext>;}
 setup=await testRender(<Harness/>,{width:120,height:28});for(let i=0;i<3;i++)await act(async()=>setup.renderOnce());await act(async()=>{setup.mockInput.pressKey("e");await setup.renderOnce();});await act(async()=>setup.renderOnce());
}
async function capture(name:string,financials:any,period="annual"){
 if(out)writeFileSync(`${out}/${name}.txt`,setup.captureCharFrame());await exportPaneTable(paneId,`${name}.csv`);const csv=takeSavedTextFile()!.text;if(out)writeFileSync(`${out}/${name}.csv`,csv);
 const args={symbols:["CONTROL"],argument:["CONTROL"],rawArgument:"CONTROL",options:{period,statement:"income"}};
 const result=await financialStatementsHeadless.load(args,{marketData:createTestDataProvider({getTickerFinancials:async()=>financials})});
 const text=renderHeadlessPaneText(financialStatementsHeadless,result,args,"Financials");if(out)writeFileSync(`${out}/${name}-headless.txt`,text);if(out)writeFileSync(`${out}/${name}.json`,JSON.stringify({source,input:financials,result},null,2));return {result,text,csv};
}
test("actual financial table and CSV retain the derived TTM window and known field publication dates",async()=>{
 const financials={annualStatements:[{date:"2025-12-31",currency:"USD",totalRevenue:1000,basicEps:5,eps:4.5}],quarterlyStatements:["2024-03-31","2024-06-30","2024-09-30","2024-12-31"].map((date,i)=>({date,currency:"USD",totalRevenue:100,netIncome:0,basicEps:0,eps:0,availableAt:["2024-05-01","2024-08-01","2024-11-01","2025-02-01"][i],fieldAvailability:{totalRevenue:["2024-05-01","2024-08-01","2024-11-01","2025-02-01"][i]}})),priceHistory:[]};
 await mount(financials);const {result,csv}=await capture("ttm-period",financials);expect(result.metadata.columns[0]).toMatchObject({date:"TTM",availableAt:null,fieldAvailability:{totalRevenue:"2025-02-01"},aggregation:{kind:"trailing-four-quarters",periodEnd:"2024-12-31"}});expect(result.metadata.columns[0].aggregation.sourcePeriods.map((p:any)=>p.date)).toEqual(financials.quarterlyStatements.map(p=>p.date));expect(csv).toContain("TTM 2024-12-31");expect(csv).toContain("Currency,USD");expect(setup.captureCharFrame()).toContain("TTM 2024-12-31");expect(setup.captureCharFrame()).toContain("USD · YoY");expect(result.rows.find((r:any)=>r.id==="income:revenue").TTM).toBe(400);
});
test("actual financial table exports preserve count growth independently of uncertain monetary comparisons",async()=>{
 const financials={annualStatements:[{date:"2023-12-31",totalRevenue:100,basicShares:10,eps:1},{date:"2024-12-31",currency:"JPY",totalRevenue:200,basicShares:20,eps:2},{date:"2025-12-31",currency:"USD",totalRevenue:300,basicShares:30,eps:3}],quarterlyStatements:[],priceHistory:[]};
 await mount(financials);const {result}=await capture("growth-units",financials);const rev=result.rows.find((r:any)=>r.id==="income:revenue");const shares=result.rows.find((r:any)=>r.id==="basicShares:1");expect(rev.cells[1].growth).toBeNull();expect(rev.cells[0].growth).toBeNull();expect(shares.cells[0].growth).toBe(0.5);expect(shares.cells[1].growth).toBe(1);
});
test("explicit quarterly headless report fails honestly while interactive tabs identify available annual coverage",async()=>{
 const financials={annualStatements:[{date:"2024-12-31",currency:"USD",totalRevenue:100},{date:"2025-12-31",currency:"USD",totalRevenue:200}],quarterlyStatements:[],priceHistory:[]};await mount(financials,"quarterly");const {result,text}=await capture("quarterly-fallback",financials,"quarterly");expect(result.metadata.period).toBe("quarterly");expect(text).toContain("CONTROL | quarterly | income");expect(result.rows).toEqual([]);expect(result.unavailableSymbols).toEqual(["CONTROL"]);expect(text).toContain("No quarterly financial statement coverage");expect(setup.captureCharFrame()).toContain("USD · YoY");
 const unavailable=await cli(financials,"quarterly");expect(unavailable.data).toMatchObject({complete:false,empty:true,unavailableSymbols:["CONTROL"]});
 const annual=await cli(financials,"annual");expect(annual.data).toMatchObject({complete:true,empty:false});expect(annual.text).toContain("200");
 const quarterlyOnly={...financials,annualStatements:[],quarterlyStatements:[{date:"2026-03-31",currency:"USD",totalRevenue:50}]};
 expect((await cli(quarterlyOnly,"annual")).data).toMatchObject({complete:false,empty:true});
 expect((await cli(quarterlyOnly,"quarterly")).data).toMatchObject({complete:true,empty:false});

});

test("mouse period changes keep active CSV and quarterly values aligned, including zero EPS",async()=>{
 const financials={financialCurrency:"USD",annualStatements:[{date:"2025-12-31",currency:"USD",totalRevenue:400,eps:0}],quarterlyStatements:["2025-03-31","2025-06-30","2025-09-30","2025-12-31"].map(date=>({date,currency:"USD",totalRevenue:100,eps:0})),priceHistory:[]};
 await mount(financials);await capture("navigation-annual",financials);
 async function clickPeriod(){const rows=setup.captureCharFrame().split("\n");const y=rows.findIndex((row:string)=>row.includes("[p]eriod"));expect(y).toBeGreaterThanOrEqual(0);const x=rows[y].indexOf("[p]eriod");await act(async()=>{await setup.mockMouse.click(x+1,y);await setup.renderOnce();});await act(async()=>setup.renderOnce());}
 await clickPeriod();const quarterly=await capture("navigation-quarterly",financials,"quarterly");expect(quarterly.csv).toContain("Growth,QoQ");expect(quarterly.csv).not.toContain("TTM");expect(setup.captureCharFrame()).toContain("USD · QoQ");expect(quarterly.result.rows.find((r:any)=>r.id==="eps:1").cells[0].value).toBe(0);
 await clickPeriod();const annual=await capture("navigation-returned",financials);expect(annual.csv).toContain("TTM 2025-12-31");expect(annual.csv).toContain("Currency,USD");expect(annual.csv).toContain("Growth,YoY");expect(setup.captureCharFrame()).toContain("USD · YoY");
});

for (const reportedCurrency of [undefined, "USD"]) {
 test(`historical headers and exports retain ${reportedCurrency ?? "unknown"} units across an unrelated reporting-currency change`, async () => {
  const financials={financialCurrency:"USD",annualStatements:[{date:"2024-12-31",currency:reportedCurrency,totalRevenue:100,basicShares:10},{date:"2025-12-31",currency:"USD",totalRevenue:200,basicShares:20}],quarterlyStatements:[{date:"2023-09-30",currency:"JPY",totalRevenue:50}],priceHistory:[]};
  await mount(financials);const {result,csv,text}=await capture(`currency-header-${reportedCurrency ?? "unknown"}`,financials);
  const header=result.metadata.columns.find((column:any)=>column.date==="2024-12-31");
  // Mixed reporting currencies: each column names its own.
  const expectedHeader=reportedCurrency ? "2024-12-31 P USD" : "2024-12-31 P";
  expect(header.currency).toBe(reportedCurrency ?? null);
  expect(result.metadata.currency).toBeNull();
  expect(result.rows.find((row:any)=>row.id==="income:revenue").cells[0].growth).toBe(reportedCurrency ? 1 : null);
  expect(result.rows.find((row:any)=>row.id==="basicShares:1").cells[0].growth).toBe(1);
  expect(csv).toContain(expectedHeader);
  expect(setup.captureCharFrame()).toContain(expectedHeader);
  expect(text).toContain(reportedCurrency ? "2024-12-31 USD" : "2024-12-31 (provider date)");
  expect(financials.annualStatements[0]!.currency).toBe(reportedCurrency);
 });
}
