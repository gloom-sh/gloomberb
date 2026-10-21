import { mkdir,readFile,rm,writeFile } from "node:fs/promises";
import { join,resolve } from "node:path";
const [rootArg,outArg]=process.argv.slice(2),root=resolve(rootArg!),out=resolve(outArg!);
await mkdir(out,{recursive:true});
const {writeElectrobunViewPage}=await import(join(root,'src/renderers/dom/build-assets.ts'));
const {launchBrowser,evaluate,waitFor,sleep}=await import(join(root,'scripts/pane-chrome/browser.ts'));
const {alertsPlugin}=await import(join(root,'src/plugins/builtin/alerts/index.tsx'));
const entry=join(root,'glo-1164-ui-entry.tsx'),build=join(out,'build');
await writeFile(entry,(await readFile(join(import.meta.dir,'ui-fixture.tsx'),'utf8')).replaceAll('ROOT/',root+'/'));
const nativeTraffic=[],nativeFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{if(String(input).startsWith('http://127.0.0.1:'))return nativeFetch(input,init);nativeTraffic.push(String(input));throw new Error('Offline fixture blocks network');};
let raw:unknown,command:any,notifications:any[]=[];
const quote={symbol:'AAPL',price:195,change:0,changePercent:0,currency:'USD',lastUpdated:1792574100000};
const old={id:'old',symbol:'MSFT',condition:'above',targetPrice:300,status:'triggered',createdAt:1792574000000,triggeredAt:1792574000000};
function reset(scenario:string){
 raw=scenario==='malformed'?'[{broken':scenario==='partial'?JSON.stringify([old,null]):JSON.stringify([old]);notifications=[];
 alertsPlugin.setup({registerCommand:(c)=>{if(c.id==='set-alert')command=c;},registerPane(){},registerPaneTemplate(){},configState:{get:(key)=>key==='alerts'?raw:undefined,set:async(key,value)=>{if(key==='alerts')raw=value;}},marketData:{getQuote:async()=>quote},tickerRepository:{loadTicker:async()=>null,loadAllTickers:async()=>[]},notify:(n)=>notifications.push(n),log:{info(){},warn(){}}} as any);
 alertsPlugin.dispose();
 return{raw,command,quote};
}
await writeElectrobunViewPage({entrypoint:entry,outdir:build,aliasRules:[["backend-rpc","native-stubs/backend-rpc.ts"]],failureMessage:"Alerts evidence build failed",missingEntryMessage:"Missing entry",title:"Offline alerts evidence",loadingText:"Loading",bootstrapScript:`window.__traffic=[];const f=window.fetch.bind(window);window.fetch=async(i,o)=>{if(String(i)==='/execute')return f(i,o);window.__traffic.push(String(i));throw new Error('Offline fixture blocks network');};window.WebSocket=class extends EventTarget{readyState=3;send(){}close(){}};const RealDate=Date;window.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[1792574100000]));}static now(){return 1792574100000;}};`});
const html=await Bun.file(join(build,'index.html')).text();
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const url=new URL(request.url);
 if(url.pathname==='/')return new Response(html.replace('<head>',`<head><script>window.fixture=${JSON.stringify(reset(url.searchParams.get('state')!))}</script>`),{headers:{'content-type':'text/html'}});
 if(url.pathname==='/execute'){let error=null;try{await command.execute(await request.json());}catch(e){error=e.message;}return Response.json({raw,notifications,error,nativeTraffic});}
 const file=Bun.file(join(build,url.pathname.slice(1)));return !url.pathname.includes('..')&&await file.exists()?new Response(file):new Response('Not found',{status:404});
}});
const origin=`http://127.0.0.1:${server.port}`;
try{
 for(const scenario of ['malformed','partial','healthy'])for(const theme of ['white','paper'])for(const width of [720,1280]){
  const browser=await launchBrowser('glo-1164',width,620),errors=[],blocked=[];
  try{
   const {cdp}=browser;cdp.on('Fetch.requestPaused',async({requestId,request})=>{if(request.url.startsWith(origin+'/'))await cdp.send('Fetch.continueRequest',{requestId});else{blocked.push(request.url);await cdp.send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});}});
   cdp.on('Runtime.exceptionThrown',e=>errors.push(e));await cdp.send('Runtime.enable');await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
   await cdp.send('Page.navigate',{url:`${origin}/?state=${scenario}&theme=${theme}`});
   if(!await waitFor(cdp,'window.ready===true',10000))throw new Error('Not ready '+JSON.stringify(errors));
   await evaluate(cdp,'window.openAlert()');await sleep(500);
   const buttons=await evaluate(cdp,`[...document.querySelectorAll('button')].map(b=>({text:b.innerText,disabled:b.disabled}))`);
   console.log('buttons',JSON.stringify(buttons));
   const clicked=await evaluate(cdp,`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Add Alert');if(!b)return false;b.click();return true;})()`);
   if(!clicked)throw new Error('No submit button '+JSON.stringify(buttons));
   if(!await waitFor(cdp,'!!window.outcome',10000))throw new Error('No outcome');await sleep(600);
   for(const surface of ['form','pane']){
    if(surface==='pane'){await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(250);await evaluate(cdp,"document.querySelectorAll('[aria-label=\"Dismiss notification\"]').forEach(b=>b.click())");await sleep(250);}
    const name=`${scenario}-${surface}-${theme}-${width}`;
    const info=await evaluate(cdp,`({outcome:window.outcome,text:document.body.innerText,traffic:window.__traffic,panes:[...document.querySelectorAll('[data-pane]')].map(e=>({id:e.dataset.pane,text:e.innerText,rect:e.getBoundingClientRect().toJSON()}))})`);
    await Bun.write(join(out,name+'.json'),JSON.stringify({...info,errors,blocked},null,2));
    if(errors.length||blocked.length)throw new Error(JSON.stringify({errors,blocked}));
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});await Bun.write(join(out,name+'.png'),Buffer.from(shot.data,'base64'));console.log(name);
   }
  }finally{await browser.close();}
 }
}finally{server.stop(true);alertsPlugin.dispose();await rm(entry,{force:true});await rm(build,{recursive:true,force:true});}
