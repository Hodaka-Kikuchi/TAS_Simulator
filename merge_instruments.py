from pathlib import Path
import json, shutil

ROOT=Path(__file__).resolve().parent
RES=ROOT/'instrument'
QE=ROOT/'instruments'
OUT=ROOT/'instrument_merged'
OUT.mkdir(exist_ok=True)

def load_dir(d):
    out={}
    if not d.exists(): return out
    for p in d.glob('*.json'):
        if p.name.lower()=='index.json': continue
        try: data=json.loads(p.read_text(encoding='utf-8'))
        except Exception: continue
        out[p.stem]=(p,data)
    return out

res=load_dir(RES); qe=load_dir(QE)

def norm(s): return ''.join(c.lower() for c in str(s) if c.isalnum())
for key,(p,r) in res.items():
    cand=qe.get(key)
    if cand is None:
        rn=norm(r.get('name',key))
        cand=next(((qp,q) for qp,q in qe.values() if norm(q.get('name',qp.stem))==rn),None)
    merged=dict(r)
    if cand:
        _,q=cand
        table=q.get('S2_limits') or (q.get('configuration') if isinstance(q.get('configuration'),list) else None)
        if table: merged['S2_limits']=table
        merged['S2_min']=q.get('S2_min',q.get('default_S2min',8.0))
        if 'default_energy' in q: merged.setdefault('qe_range',{})['default_energy']=q['default_energy']
    (OUT/p.name).write_text(json.dumps(merged,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print(p.name,'<-', 'merged' if cand else 'resolution only (no matching QE file)')
print('Output:',OUT)
