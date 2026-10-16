import { Jimp } from "jimp";
import { evaluate, type PageCommands } from "./browser";

export interface TranscriptView {
  visible: string[];
  rows: number;
  text: string;
  status: boolean;
  height: number;
  top: number;
  extent: number;
  clip: { x: number; y: number; width: number; height: number };
  background: number[];
  occluded: Array<{ x: number; y: number; width: number; height: number }>;
  textRects: Array<{ x: number; y: number; width: number; height: number }>;
}

/** Geometry alone deliberately does not claim that any glyphs were painted. */
export const transcriptView = (paneId = "chat:a", pixels = false) => `(() => {
  const list=document.querySelector('[data-gloom-pane-id="${paneId}"] [data-gloom-role=chat-transcript]');
  if(!list)return {visible:[],rows:0,text:'',height:0,status:false,textRects:[]};
  const rect=list.getBoundingClientRect();
  const top=Math.max(0,rect.top), bottom=Math.min(innerHeight,rect.bottom);
  const left=Math.max(0,rect.left), right=Math.min(innerWidth,rect.right);
  const shown=list.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const intersects=r=>shown && r.height>0 && r.width>0 && r.bottom>top && r.top<bottom && r.right>left && r.left<right;
  const messages=[...list.querySelectorAll('[data-gloom-role=chat-message]')];
  const visibleRows=messages.filter(el=>intersects(el.getBoundingClientRect()));
  const visible=visibleRows.map(el=>el.getAttribute('data-gloom-chat-message-id'));
  const range=document.createRange();range.selectNodeContents(list);
  const status=messages.length===0 && [...range.getClientRects()].some(intersects);
  const textRects=[];
  if(${pixels}) for(const el of messages.length ? visibleRows : [list]) {
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {
      if(!walker.currentNode.textContent.trim())continue;
      range.selectNodeContents(walker.currentNode);
      for(const r of range.getClientRects()) if(intersects(r)) {
        const x=Math.max(left,r.left), y=Math.max(top,r.top);
        textRects.push({x,y,width:Math.min(right,r.right)-x,height:Math.min(bottom,r.bottom)-y});
      }
    }
  }
  const occluded=[];
  if(${pixels}) for(const pane of document.querySelectorAll('[data-gloom-role=pane-window], [data-gloom-role=detached-pane-window]')) {
    if(pane.contains(list) || !pane.checkVisibility())continue;
    const r=pane.getBoundingClientRect();
    const x=Math.max(left,r.left), y=Math.max(top,r.top), width=Math.min(right,r.right)-x, height=Math.min(bottom,r.bottom)-y;
    if(width>0 && height>0 && !list.contains(document.elementFromPoint(x+width/2,y+height/2))) occluded.push({x,y,width,height});
  }
  let background=[0,0,0];
  if(${pixels}) for(let el=list;el;el=el.parentElement) {
    const color=getComputedStyle(el).backgroundColor.match(/[\\d.]+/g)?.map(Number);
    if(color?.length===3 || color?.[3]===1){background=color.slice(0,3);break;}
  }
  return {visible,rows:messages.length,text:messages.length?'':list.innerText,status,height:rect.height,
    top:list.scrollTop,extent:list.scrollHeight,clip:{x:left,y:top,width:right-left,height:bottom-top},background,occluded,textRects};
})()`;

/**
 * Capture the viewport before sending any scroll or pointer input. Count ink
 * against the pane background both across the scrollport and inside visible
 * text ranges, so chrome, a scrollbar or an empty row's border cannot pass it.
 * This samples browser screenshots, not native GPU presentation.
 */
export async function transcriptPaint(cdp: PageCommands, paneId = "chat:a") {
  const view = await evaluate<TranscriptView>(cdp, transcriptView(paneId, true));
  const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(data, "base64");
  const { bitmap } = await Jimp.read(png);
  const ink = (rect: TranscriptView["clip"]): number => {
    let count = 0;
    for (let y = Math.max(0, Math.ceil(rect.y)); y < Math.min(bitmap.height, Math.floor(rect.y + rect.height)); y++) {
      for (let x = Math.max(0, Math.ceil(rect.x)); x < Math.min(bitmap.width, Math.floor(rect.x + rect.width)); x++) {
        if (view.occluded.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue;
        const at = (y * bitmap.width + x) * 4;
        if (view.background.some((value, channel) => Math.abs(bitmap.data[at + channel]! - value) > 24)) count++;
      }
    }
    return count;
  };
  const viewportInk = view.clip ? ink(view.clip) : 0;
  const textInk = view.textRects.reduce((sum, rect) => sum + ink(rect), 0);
  const painted = viewportInk >= 20 && textInk >= 20;
  // Large text-rectangle arrays are diagnostic only; keep the result compact.
  const { textRects, ...geometry } = view;
  return { view: geometry, viewportInk, textInk, textRects: textRects.length, painted, png };
}
