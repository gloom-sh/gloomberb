from pathlib import Path
import json,subprocess
E=Path(__file__).resolve().parent;out=E/'screenshots/comparisons';out.mkdir(exist_ok=True);records=[]
def change(a,b):
 r=subprocess.run(['compare','-metric','AE',str(a),str(b),'null:'],capture_output=True,text=True)
 if r.returncode not in (0,1):raise RuntimeError(r.stderr)
 return int(float(r.stderr.strip()))
def sheet(a,b,name):
 width=int(subprocess.check_output(['identify','-format','%w',str(a)],text=True))
 subprocess.run(['convert',str(a),str(b),'+append','-background','#e6e6e6','-fill','black','-font','Courier-10-Pitch-Regular','-pointsize','16','+repage','-gravity','north','-splice','0x36','+repage','-gravity','northwest','-annotate','+8+8','Before · main 0568f95','-annotate',f'+{width+8}+8','After · GLO-1164 6578fe8',str(out/name)],check=True)
for before in sorted((E/'screenshots/baseline-unobstructed').glob('*-pane-*.png')):
 after=E/'screenshots/head-unobstructed'/before.name
 a=json.loads(before.with_suffix('.json').read_text());b=json.loads(after.with_suffix('.json').read_text());r=a['panes'][1]['rect'];crop=f"{int(r['width'])}x{int(r['height'])}+{int(r['x'])}+{int(r['y'])}"
 crops=[]
 for i,f in enumerate([before,after]):
  dest=out/f'crop-{i}.png';subprocess.run(['convert',str(f),'-crop',crop,'+repage',str(dest)],check=True);crops.append(dest)
 neighbor=change(*crops)
 for f in crops:f.unlink()
 row={'case':before.stem,'neighborChangedPixels':neighbor,'changedPixels':change(before,after),'runtimeErrors':a['errors']+b['errors'],'blocked':a['blocked']+b['blocked'],'network':a['traffic']+b['traffic'],'before':a['outcome'],'after':b['outcome']}
 assert neighbor==0,row
 if before.name.startswith('healthy'):assert row['changedPixels']==0,row
 records.append(row);sheet(before,after,before.name)
 form=before.name.replace('-pane-','-form-');sheet(before.with_name(form),after.with_name(form),form)
for theme in ['white','paper']:
 for suffix in ['','-pane']:
  a=E/'terminal-final'/f'baseline-partial-{theme}{suffix}.png';b=E/'terminal-final'/f'head-partial-{theme}{suffix}.png';sheet(a,b,f'terminal-partial-{theme}{suffix}.png')
(E/'screenshots/comparison.json').write_text(json.dumps(records,indent=2)+'\n');print(len(records),'pane pairs; all neighbor crops identical; healthy controls identical; plus12 form pairs and4 terminal pairs')
