from pathlib import Path
import datetime, hashlib, json, re, subprocess
D=Path(__file__).resolve().parent;P=D.parent;W=P/'worktree'
HEAD='40b68e5d0b03132dd7156a90460dc07ec6a07e2c';BASE='0568f95db049dccad254c672c2c8d284bbe6a586'
load=lambda p:json.loads(p.read_text());sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def call(*args):return subprocess.check_output(list(args),text=True).strip()
def pixels(a,b,region=''):
 r=subprocess.run(['compare','-metric','AE',str(a)+region,str(b)+region,'null:'],capture_output=True,text=True)
 assert r.returncode in (0,1),(a,b,r.stderr)
 return int(float(r.stderr.strip()))
def size(p):return tuple(map(int,call('identify','-format','%w %h',str(p)).split()))
def save(p,r):p.write_text(json.dumps(r,indent=2)+'\n')
assert call('git','-C',str(W),'rev-parse','HEAD')==HEAD
source=[]
for path in ['src/plugins/builtin/alerts/pane.tsx','src/plugins/builtin/alerts/alert-engine.ts','src/plugins/builtin/alerts/index.tsx','src/plugins/builtin/themes/pane.tsx']:
 for side,folder,ref in [('before',D/'baseline',BASE),('after',W,HEAD)]:
  expected=call('git','-C',str(W),'rev-parse',ref+':'+path);actual=call('git','hash-object',str(folder/path));assert actual==expected
  source.append({'side':side,'path':path,'ref':ref,'blob':actual})
provenance=load(D/'source-provenance.json');assert provenance['head']==HEAD and provenance['baseline']==BASE
for fixture in provenance['desktopFixtures']:assert sha((D/fixture['path']).resolve())==fixture['sha256']
captures=load(D/'terminal-captures.json');assert len(captures)==8
assert {(r['side'],r['scenario'],r['theme']) for r in captures}=={(s,c,t) for s in ['baseline','head'] for c in ['malformed','partial'] for t in ['white','paper']}
for r in captures:
 assert not r['result']['network'];outcome=r['result']['outcome']
 assert bool(outcome['error'])==(r['side']=='head')
 if r['side']=='head':
  if r['scenario']=='malformed':assert outcome['raw']=='[{broken'
  else:assert json.loads(outcome['raw'])[-1] is None
runtime=[]
for p in sorted((D/'terminal-final').glob('*.runtime.log')):
 text=p.read_text(errors='replace');matches=re.findall(r'(?:Warning:|Unhandled(?:Promise)?(?:Rejection)?|TypeError:|ReferenceError:|Invalid hook|Maximum update depth|not wrapped in act)[^\n\r]*',text)
 assert not matches,(p,matches);runtime.append({'path':str(p.relative_to(D)),'sha256':sha(p),'knownRuntimeWarningMatches':matches})
assert len(runtime)==8
sessions=subprocess.run(['tmux','list-sessions','-F','#{session_name}'],capture_output=True,text=True)
assert sessions.returncode==0 or 'no server running' in sessions.stderr
owned=[s for s in sessions.stdout.splitlines() if s.startswith('glo1164-body-')];assert not owned
profiles=list((Path.home()/'.cache/gloom-smoke').glob('glo-1164-body-tmux-*'));assert not profiles
entries=[D/'baseline/glo-1164-terminal.tsx',W/'glo-1164-terminal.tsx'];assert all(not p.exists() for p in entries)
T=D/'terminal-final';S=D/'screenshots/terminal';S.mkdir(exist_ok=True);terminal=[]
for scenario in ['malformed','partial']:
 for theme in ['white','paper']:
  for state,suffix in [('form',''),('pane','-pane')]:
   a=T/f'baseline-{scenario}-{theme}{suffix}.png';b=T/f'head-{scenario}-{theme}{suffix}.png';w,h=size(a);assert size(b)==(w,h)==(1440,816)
   changes=pixels(a,b);neighbor=pixels(a,b,f'[{w//2}x{h}+{w//2}+0]')
   neighbor_content=pixels(a,b,f'[{w//2}x720+{w//2}+0]')
   if state=='pane':assert neighbor_content==0,(scenario,theme,neighbor_content)
   text=(b.with_suffix('.txt')).read_text(errors='replace')
   if scenario=='malformed' and state=='pane':
    assert text.count('price alerts unavailable.')==1;assert 'Saved alerts could not be read.' not in text
   if scenario=='partial' and state=='pane':assert 'MSFT' in text and 'price alerts unavailable.' not in text
   sheet=S/f'{scenario}-{state}-{theme}.png'
   subprocess.run(['convert',str(a),str(b),'+append','-background','#e6e6e6','-fill','black','-font','Courier-10-Pitch-Regular','-pointsize','16','+repage','-gravity','north','-splice','0x36','+repage','-gravity','northwest','-annotate','+8+8',f'Before main 0568f95 | {scenario} {state} {theme}','-annotate',f'+{w+8}+8',f'After 40b68e5 | {scenario} {state} {theme}',str(sheet)],check=True)
   terminal.append({'scenario':scenario,'theme':theme,'state':state,'before':str(a.relative_to(D)),'after':str(b.relative_to(D)),'beforeSha256':sha(a),'afterSha256':sha(b),'changedPixels':changes,'neighborRightHalfChangedPixels':neighbor,'unobstructedNeighborContentChangedPixels':neighbor_content,'unobstructedNeighborContentRegion':{'x':720,'y':0,'width':720,'height':720} if state=='pane' else None,'neighborFooterObscuredByBaselineSuccessToast':state=='pane','sheet':str(sheet.relative_to(D)),'sheetSha256':sha(sheet)})
terminal_result={'head':HEAD,'baseline':BASE,'pairs':8,'rawCaptures':16,'terminalCells':[120,34],'dimensions':[1440,816],'unobstructedNeighborContentPairs':4,'unobstructedNeighborContentPixelsChanged':0,'fullNeighborInvarianceClaimed':False,'overlayQualification':'Baseline successfully saves and displays a success toast across the bottom-right neighbor/footer. Head correctly rejects storage and shows no success toast. Full-frame and right-half differences are retained. Only the content region above y=720 is unobstructed on both sides.','captureRerun':False,'networkRequests':0,'knownRuntimeWarningMatches':0,'runtimeLogs':runtime,'ownedCleanup':{'remainingSessions':owned,'remainingProfiles':[],'temporaryEntryFilesRemoved':True},'sourceBlobs':source,'records':terminal,'limitation':'Registered renderer-component fixtures; no full native desktop shell or native RPC transport exercised. Form overlays obscure the neighbor, and baseline pane-state success toasts cover its footer. Only the independently measured neighbor content region above y=720 is invariant.'}
save(D/'terminal-audit.json',terminal_result)
desktop=[]
for label in ['main','correction']:
 comparison=load(D/'screenshots'/f'{label}.json');assert comparison['head']==HEAD and comparison['pairedImages']==24
 rows=[]
 for row in comparison['records']:
  a=P/row['before'];b=P/row['after'];assert sha(a)==row['beforeSha256'] and sha(b)==row['afterSha256'];changed=pixels(a,b);assert changed==row['changedPixels']
  metadata=load(b.with_suffix('.json'));assert all(not metadata[k] for k in ['errors','blocked','traffic']) and not metadata['outcome']['nativeTraffic']
  original_metadata=load(a.with_suffix('.json'));assert all(not original_metadata[k] for k in ['errors','blocked','traffic']) and not original_metadata['outcome']['nativeTraffic']
  checked={'case':row['case'],'changedPixels':changed,'beforeSha256':sha(a),'afterSha256':sha(b)}
  if '-pane-' in row['case']:
   before_meta=load(a.with_suffix('.json'));rect=metadata['panes'][1]['rect'];assert before_meta['panes'][1]['rect']==rect
   region=f"[{int(rect['width'])}x{int(rect['height'])}+{int(rect['x'])}+{int(rect['y'])}]";assert pixels(a,b,region)==0
   checked['unobstructedNeighborChangedPixels']=0
   if row['case'].startswith('malformed'):
    pane_text=metadata['panes'][0]['text'];assert pane_text.count('price alerts unavailable.')==1 and 'Saved alerts could not be read.' not in pane_text
    assert pane_text.count('Saved price alerts could not be read:')==2;checked['sharedErrorTitleOnce']=True;checked['errorDetailOccurrencesBodyPlusFooter']=2
   if row['case'].startswith('partial'):assert 'MSFT' in metadata['panes'][0]['text'] and 'price alerts unavailable.' not in metadata['panes'][0]['text']
  if row['case'].startswith('healthy'):assert changed==0
  if label=='correction' and row['case'].startswith('partial'):
   if row['case']=='partial-form-paper-1280':
    bbox=call('convert',str(a),str(b),'-compose','difference','-composite','-threshold','0','-format','%@','info:');assert changed==14 and bbox=='1x14+421+234'
    checked['exception']={'kind':'Blinking input caret','changedPixels':14,'boundingBox':bbox,'manualCrop':'screenshots/caret-comparison.png','scope':'Only the Symbol input caret; raw originals and full-image difference are preserved.'}
   else:assert changed==0
  rows.append(checked)
 desktop.append({'comparison':label,'pairs':len(rows),'unobstructedNeighborPairs':sum('unobstructedNeighborChangedPixels' in r for r in rows),'records':rows})
result={'head':HEAD,'baseline':BASE,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'captureRerun':False,'desktopComparisons':desktop,'terminalAudit':'terminal-audit.json','desktopRuntimeErrors':0,'desktopBlockedRequests':0,'desktopExternalRequests':0,'desktopNativeTraffic':0,'terminalExternalRequests':0,'terminalKnownRuntimeWarnings':0,'ownedTmuxSessionsAndProfilesRemoved':True,'desktopFixturesHashesVerified':provenance['desktopFixtures'],'sourceProvenanceSha256':sha(D/'source-provenance.json'),'manualReview':'Pending image inspection of assembled terminal and representative desktop sheets.','limitations':['The before images for desktop comparisons are retained captures from their explicitly recorded baseline/previous revisions.','Desktop unobstructed pane frames establish full-neighbor invariance. Terminal baseline success toasts cover the neighbor footer, so terminal invariance applies only to its unobstructed content above y=720.','The captured error detail remains once in the body and again in the existing footer; the body has one shared error title.','Runtime scans cover eight finite terminal smoke logs, not long-term leak absence.']}
save(D/'independent-screenshot-review.json',result)
print(json.dumps({'terminalPairs':len(terminal),'desktopPairs':sum(x['pairs'] for x in desktop),'neighborPairs':4+sum(x['unobstructedNeighborPairs'] for x in desktop),'caretException':'14 pixels, 1x14+421+234','runtimeErrors':0,'networkRequests':0,'ownedCleanup':True}))
