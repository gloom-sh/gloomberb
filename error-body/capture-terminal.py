import os,subprocess,time,pathlib,json
E=pathlib.Path(__file__).resolve().parent
BUN='/home/vince/.cache/bun-1.3.11/bun-linux-x64/bun'
records=[]
for side,folder in [('baseline','baseline'),('head','../worktree')]:
 root=E/folder
 entry=root/'glo-1164-terminal.tsx'
 entry.write_text((E/'terminal-fixture.tsx').read_text().replace('ROOT/',str(root)+'/'))
 try:
  for scenario,theme in [(s,t) for s in ['malformed','partial'] for t in ['white','paper']]:
   profile=pathlib.Path.home()/'.cache/gloom-smoke'/f'glo-1164-body-tmux-{side}-{scenario}-{theme}'
   profile.mkdir(parents=True,exist_ok=True)
   (profile/'config.json').write_text(json.dumps({'dataDir':str(profile),'onboardingComplete':True}))
   out=E/'terminal-final'/f'{side}-{scenario}-{theme}';out.parent.mkdir(exist_ok=True);session=f'glo1164-body-{side}-{scenario}-{theme}'
   import shlex
   cmd=shlex.join(['env','NODE_ENV=test','GLOOMBERB_HOME='+str(profile),BUN,str(entry),str(out),theme,scenario])
   subprocess.run(['tmux','new-session','-d','-s',session,'-x','120','-y','34',cmd],check=True)
   try:
    subprocess.run(['tmux','pipe-pane','-o','-t',session,'cat > '+shlex.quote(str(out)+'.runtime.log')],check=True)
    for _ in range(400):
     if pathlib.Path(str(out)+'.ready').exists():break
     time.sleep(.05)
    else:raise RuntimeError('Terminal did not become ready: '+str(out))
    time.sleep(1)
    subprocess.run(['tmux','send-keys','-t',session,'C-s'],check=True)
    for _ in range(400):
     if pathlib.Path(str(out)+'.form-ready').exists():break
     time.sleep(.05)
    else:raise RuntimeError('Terminal did not capture: '+str(out))
    subprocess.run(['tmux','send-keys','-t',session,'Escape'],check=True)
    pathlib.Path(str(out)+'.dismissed').write_text('dismissed')
    for _ in range(200):
     if pathlib.Path(str(out)+'.done').exists():break
     time.sleep(.05)
    else:raise RuntimeError('Terminal did not finish capture')
    result=subprocess.run(['tmux','capture-pane','-p','-t',session],capture_output=True,text=True)
    pathlib.Path(str(out)+'.tmux.txt').write_text(result.stdout)
    records.append({'side':side,'scenario':scenario,'theme':theme,'result':json.loads(pathlib.Path(str(out)+'.json').read_text())})
   finally:
    subprocess.run(['tmux','kill-session','-t',session],capture_output=True)
    import shutil;shutil.rmtree(profile)
 finally:entry.unlink(missing_ok=True)
(E/'terminal-captures.json').write_text(json.dumps(records,indent=2)+'\n')
print(json.dumps(records,indent=2))
