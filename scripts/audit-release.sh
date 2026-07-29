#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
from pathlib import Path
import re
files=sorted(Path('supabase/migrations').glob('*.sql'))
names=[p.name.split('_',1)[0] for p in files]
assert names==sorted(names) and len(names)==len(set(names)), 'migrations non ordonnées ou dupliquées'
for path in files:
    sql=path.read_text()
    for block in re.findall(r'create(?: or replace)? function\b.*?\$\$;',sql,re.I|re.S):
        if re.search(r'security\s+definer',block,re.I):
            assert re.search(r'set\s+search_path\s*=',block,re.I), f'SECURITY DEFINER sans search_path: {path}'
print(f'ok: {len(files)} migrations ordonnées; SECURITY DEFINER search_path vérifié')
excluded=('README.md','docs/','supabase/functions/','tests/','scripts/audit-release.sh','node_modules/','.git/','test-results/','playwright-report/')
secret=re.compile(r'SUPABASE_SERVICE_ROLE_KEY\s*[:=]|service_role\s*[:=]\s*["\'][A-Za-z0-9._-]+',re.I)
for path in Path('.').rglob('*'):
    name=path.as_posix().lstrip('./')
    if path.is_file() and not any(name==x or name.startswith(x) for x in excluded):
        try: text=path.read_text()
        except (UnicodeDecodeError,OSError): continue
        assert not secret.search(text), f'secret service_role hors code serveur: {name}'
print('ok: frontière service_role vérifiée')
PY
rg -q 'enable row level security' supabase/migrations/*.sql
rg -q 'create index|create unique index' supabase/migrations/*.sql
rg -q 'set search_path' supabase/migrations/*.sql
echo 'ok: RLS, index, search_path et frontière service_role détectés'
