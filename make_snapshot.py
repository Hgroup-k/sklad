"""Собирает файл копии склада (формат резервной копии) из выгрузки ArtifactData out_dir.
python3 make_snapshot.py <out_dir> <файл.json>"""
import json, sys, pathlib, datetime
d = pathlib.Path(sys.argv[1]); out = sys.argv[2]
rd = lambda p: json.loads(p.read_text(encoding='utf8'))
def docs(sub):
    p = d / sub
    return [dict(rd(f), id=f.stem) for f in sorted(p.glob('*.json'))] if p.exists() else []
cfg = lambda n: rd(d/'config'/(n+'.json')) if (d/'config'/(n+'.json')).exists() else None
ops = {}
for m in sorted((d/'months').glob('*')) if (d/'months').exists() else []:
    l = docs(f'months/{m.name}/ops')
    if l: ops[m.name] = l
snap = {'v':1,'at':datetime.datetime.utcnow().isoformat()+'Z','catalog':cfg('catalog'),'plan':cfg('plan'),'lists':cfg('lists'),'orders':docs('orders'),'returns':docs('returns'),'ops':ops}
pathlib.Path(out).write_text(json.dumps(snap, ensure_ascii=False), encoding='utf8')
print('orders', len(snap['orders']), 'returns', len(snap['returns']), 'ops', sum(len(v) for v in ops.values()))
