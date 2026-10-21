import { useEffect, useMemo, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { DomHostProviders } from "ROOT/src/renderers/dom/dom-host-providers";
import { createWebUiHost, webRendererHost } from "ROOT/src/renderers/electrobun/view/ui-host";
import { useToastHost } from "ROOT/src/ui/toast";
import { appReducer, createInitialState } from "ROOT/src/state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "ROOT/src/test-support/pane";
import { createConfigBackedTestPluginRuntime, createTestPluginRuntime } from "ROOT/src/test-support/plugin-runtime";
import { ThemeProvider } from "ROOT/src/theme/theme-context";
import { AlertsPane } from "ROOT/src/plugins/builtin/alerts/pane";
import { ThemesBoard } from "ROOT/src/plugins/builtin/themes/pane";
import { FormModalHost, openFormModal } from "ROOT/src/components/form-modal";
import { apiClient } from "ROOT/src/api-client";
import "ROOT/src/renderers/dom/styles.css";
const params = new URLSearchParams(location.search), theme = params.get("theme") ?? "white";
const fixture = (window as any).fixture;
apiClient.getCloudThemes = async () => { throw new Error("Cannot read the saved thematic baskets."); };
function Pane({ neighbour = false }) {
 const id = neighbour ? "themes" : "alerts";
 const config = useMemo(() => {
  const value = createTestPaneConfig("/offline-evidence", {instanceId:id,paneId:id,params:{},settings:{}});
  value.theme=theme; value.telemetry={crashReports:false,usage:false};
  value.pluginConfig.alerts = { alerts: fixture.raw };
  return value;
 }, []);
 const [state,dispatch]=useReducer(appReducer,createInitialState(config));
 const toast=useToastHost();
 const runtime = createConfigBackedTestPluginRuntime({getConfig:()=>state.config,setConfig:config=>dispatch({type:"SET_CONFIG",config})}, {
  openPluginCommandWorkflow:()=>openFormModal({kind:"plugin-command",commandId:"set-alert",values:{symbol:"AAPL",condition:"above",price:"200"}}),
  notify:notice=>toast[notice.type??"info"](notice.body,{duration:0}),
 });
 const command={...fixture.command,execute:async(values)=>{
  const result=await fetch('/execute',{method:'POST',body:JSON.stringify(values)}).then(r=>r.json());
  (window as any).outcome=result;
  dispatch({type:"SET_CONFIG",config:{...state.config,pluginConfig:{...state.config.pluginConfig,alerts:{alerts:result.raw}}}});
  for(const n of result.notifications)toast[n.type??"info"](n.body,{duration:0});
  if(result.error)throw new Error(result.error);
 }};
 const registry={commands:new Map([[command.id,command]]),allPlugins:new Map([["alerts",{name:"Alerts"}]]),getCommandPluginId:()=>"alerts",notify:()=>{}};
 const dataProvider={getQuote:async()=>fixture.quote};
 const tickerRepository={loadTicker:async()=>null,loadAllTickers:async()=>[]};
 useEffect(()=>{if(!neighbour){(window as any).openAlert=()=>openFormModal({kind:"plugin-command",commandId:"set-alert",values:{symbol:"AAPL",condition:"above",price:"200"}});(window as any).ready=true;}},[]);
 const width=Math.floor((window.innerWidth/2-24)/8),height=29;
 return <section data-pane={id} style={{minWidth:0,flex:1,border:"1px solid var(--gloom-hairline)",background:"var(--gloom-bg)",overflow:"hidden"}}><div style={{height:20,padding:"0 var(--gloom-inset)",fontWeight:700,borderBottom:"1px solid var(--gloom-hairline)"}}>{neighbour?"Thematic baskets":"Alerts"}</div><TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId={id} runtime={neighbour?createTestPluginRuntime():runtime} width={width} height={height} footerKeys>{body=><>{neighbour?<ThemesBoard {...body} focused={false}/>:<><AlertsPane paneId={id} paneType={id} focused {...body}/><FormModalHost dataProvider={dataProvider as any} pluginRegistry={registry as any} tickerRepository={tickerRepository as any}/></>}</>}</TestPaneFrame>{!neighbour&&<toast.Viewport/>}</section>;
}
createRoot(document.getElementById("root")!).render(<DomHostProviders ui={createWebUiHost("linux")} renderer={webRendererHost}><ThemeProvider themeId={theme}><main style={{display:"flex",padding:"var(--gloom-space-sm)",gap:"var(--gloom-space-sm)",color:"var(--gloom-text)",height:"100%"}}><Pane/><Pane neighbour/></main></ThemeProvider></DomHostProviders>);
