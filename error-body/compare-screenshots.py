from pathlib import Path
import json,subprocess,hashlib
D=Path(__file__).resolve().parent.parent;N=D/'error-body';H=N/'screenshots/head'
def pixels(a,b):
 r=subprocess.run(['compare','-metric','AE',str(a),str(b),'null:'],capture_output=True,text=True)
 assert r.returncode in (0,1),r.stderr
 return int(float(r.stderr.strip()))
all_records=[]
for label,folder,ref in [('main',D/'screenshots/baseline-unobstructed','main0568f95'),('correction',D/'screenshots/head-unobstructed','6578fe8 (runtime equivalent to8b8)')]:
 out=N/'screenshots'/label;out.mkdir(parents=True,exist_ok=True);records=[]
 for after in sorted(H.glob('*.png')):
  before=folder/after.name;a=json.loads(before.with_suffix('.json').read_text());b=json.loads(after.with_suffix('.json').read_text());assert all(not b[k] for k in ['errors','blocked','traffic']);assert not b['outcome']['nativeTraffic']
  changed=pixels(before,after);r={'case':after.stem,'before':str(before.relative_to(D)),'after':str(after.relative_to(D)),'beforeSha256':hashlib.sha256(before.read_bytes()).hexdigest(),'afterSha256':hashlib.sha256(after.read_bytes()).hexdigest(),'changedPixels':changed,'errors':b['errors'],'blocked':b['blocked'],'traffic':b['traffic']}
  if '-pane-' in after.name:
   rect=a['panes'][1]['rect'];rect2=b['panes'][1]['rect'];assert rect==rect2
   crop=f"{int(rect['width'])}x{int(rect['height'])}+{int(rect['x'])}+{int(rect['y'])}";crops=[]
   try:
    for i,p in enumerate([before,after]):
     dest=out/f'neighbor-{i}.png';subprocess.run(['convert',str(p),'-crop',crop,'+repage',str(dest)],check=True);crops.append(dest)
    r['neighborChangedPixels']=pixels(*crops);assert r['neighborChangedPixels']==0,r
   finally:
    for p in crops:p.unlink(missing_ok=True)
   if after.name.startswith('healthy'):assert changed==0,r
   if after.name.startswith('malformed'):
    text=b['panes'][0]['text'];assert text.count('price alerts unavailable.')==1;assert 'Saved alerts could not be read.' not in text;r['singleSharedErrorTitle']=True;r['detailOccurrencesIncludingRetainedFooter']=text.count('Saved price alerts could not be read:');assert r['detailOccurrencesIncludingRetainedFooter']==2
   if label=='correction' and after.name.startswith('partial'):assert changed==0,r
  width=int(subprocess.check_output(['identify','-format','%w',str(before)],text=True))
  subprocess.run(['convert',str(before),str(after),'+append','-background','#e6e6e6','-fill','black','-font','Courier-10-Pitch-Regular','-pointsize','16','+repage','-gravity','north','-splice','0x36','+repage','-gravity','northwest','-annotate','+8+8','Before '+ref,'-annotate',f'+{width+8}+8','After40b68e5',str(out/after.name)],check=True)
  records.append(r)
 result={'beforeSource':ref,'head':'40b68e5d0b03132dd7156a90460dc07ec6a07e2c','baselineReuse':True,'fixtureProvenance':'../source-provenance.json','records':records,'pairedImages':len(records),'unobstructedNeighborPairs':sum('neighborChangedPixels' in r for r in records),'healthyPanePairsIdentical':sum(r['case'].startswith('healthy-pane') and r['changedPixels']==0 for r in records)}
 (N/'screenshots'/f'{label}.json').write_text(json.dumps(result,indent=2)+'\n');all_records.append({'comparison':label,'pairs':len(records),'changed':sum(r['changedPixels']>0 for r in records),'neighborPairs':result['unobstructedNeighborPairs'],'healthyPanePairsIdentical':result['healthyPanePairsIdentical']})
print(json.dumps(all_records,indent=2))
