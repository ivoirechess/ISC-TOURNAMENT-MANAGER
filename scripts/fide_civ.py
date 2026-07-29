#!/usr/bin/env python3
"""Import the official monthly FIDE list for federation CIV (TXT or XML)."""
from __future__ import annotations
import argparse, hashlib, json, os, re, subprocess, sys, unicodedata, urllib.request, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
DEFAULT_URL="https://ratings.fide.com/download/standard_rating_list.zip"

def nullable_rating(value):
    value=(value or "").strip()
    try: n=int(value)
    except ValueError: return None
    return n if n>0 else None

def normalized(name):
    return " ".join("".join(c for c in unicodedata.normalize("NFKD",name) if not unicodedata.combining(c)).casefold().split())

def record(fid,name,title,fed,std=None,rapid=None,blitz=None,active=None,other_titles=None):
    return {"fide_id":int(fid),"name":name.strip(),"federation":fed.strip().upper(),"fide_title":title.strip() or None,"other_titles":other_titles or [],"rating_std":nullable_rating(std),"rating_rapid":nullable_rating(rapid),"rating_blitz":nullable_rating(blitz),"fide_active":active,"normalized_name":normalized(name)}

def parse_txt(text):
    lines=text.splitlines(); out=[]
    header=lines[0].lower() if lines else ""
    for line in lines[1:] if "fide" in header or "name" in header else lines:
        if not line.strip(): continue
        # Official fixed-width list.
        try:
            fid=line[0:15].strip(); name=line[15:76].strip(); title=line[76:80].strip(); fed=line[80:83].strip()
            if not fid.isdigit():
                parts=re.split(r"[;\t]",line); fid,name,title,fed=parts[:4]; std=parts[4] if len(parts)>4 else ""; rapid=parts[5] if len(parts)>5 else ""; blitz=parts[6] if len(parts)>6 else ""
            else:
                std=line[113:117]; rapid=line[135:139] if len(line)>=139 else ""; blitz=line[157:161] if len(line)>=161 else ""
            if fed.upper()=="CIV": out.append(record(fid,name,title,fed,std,rapid,blitz,active="i" not in line[131:135].lower()))
        except (ValueError,IndexError): continue
    return out

def first(node,*names):
    for name in names:
        value=node.findtext(name)
        if value is not None:return value
    return ""

def parse_xml(data):
    root=ET.fromstring(data);out=[]
    for node in root.findall(".//player"):
        fed=first(node,"country","federation","fed").upper()
        if fed!="CIV":continue
        out.append(record(first(node,"fideid","fide_id","id"),first(node,"name"),first(node,"title"),fed,first(node,"rating","standard_rating"),first(node,"rapid_rating"),first(node,"blitz_rating"),active=first(node,"flag","active").lower() not in {"i","inactive","false"}))
    return out

def load(path):
    raw=Path(path).read_bytes()
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            name=next(n for n in z.namelist() if n.lower().endswith((".xml",".txt")))
            raw=z.read(name)
    return (parse_xml(raw) if raw.lstrip().startswith(b"<") else parse_txt(raw.decode("utf-8-sig",errors="replace"))),raw

def sql(records,period):
    def q(v):return "null" if v is None else "'"+str(v).replace("'","''")+"'"
    rows=[]
    for r in records:
        rows.append("("+",".join([str(r['fide_id']),q(r['name']),q(r['federation']),q(r['fide_title']),"array[]::text[]",q(r['rating_std']),q(r['rating_rapid']),q(r['rating_blitz']),q(r['fide_active']),q(period),"now()",q(r['normalized_name']),"'FIDE'"]) + ")")
    if not rows:return "select 0;"
    return "insert into public.players(fide_id,name,federation,fide_title,other_titles,rating_std,rating_rapid,rating_blitz,fide_active,source_period,fide_synced_at,normalized_name,source) values\n"+",\n".join(rows)+" on conflict(fide_id) do update set name=excluded.name,federation=excluded.federation,fide_title=excluded.fide_title,other_titles=excluded.other_titles,rating_std=excluded.rating_std,rating_rapid=excluded.rating_rapid,rating_blitz=excluded.rating_blitz,fide_active=excluded.fide_active,source_period=excluded.source_period,fide_synced_at=excluded.fide_synced_at,normalized_name=excluded.normalized_name,source=excluded.source;"

def main(argv=None):
    p=argparse.ArgumentParser();g=p.add_mutually_exclusive_group(required=True);g.add_argument("--input");g.add_argument("--download",nargs="?",const=DEFAULT_URL)
    p.add_argument("--output",required=True);p.add_argument("--period",required=True);p.add_argument("--dry-run",action="store_true");p.add_argument("--apply",action="store_true");a=p.parse_args(argv)
    if a.download:
        target=Path(a.output).with_suffix(".download");urllib.request.urlretrieve(a.download,target);source=target
    else:source=Path(a.input)
    records,raw=load(source); report={"period":a.period,"federation":"CIV","records":len(records),"sha256":hashlib.sha256(raw).hexdigest(),"source":str(source)}
    Path(a.output).write_text(json.dumps({"report":report,"players":records},ensure_ascii=False,indent=2),encoding="utf-8")
    if a.apply and not a.dry_run:
        url=os.environ.get("DATABASE_URL");
        if not url:raise SystemExit("DATABASE_URL est obligatoire avec --apply")
        subprocess.run(["psql",url,"-v","ON_ERROR_STOP=1"],input=sql(records,a.period),text=True,check=True)
    print(json.dumps(report,ensure_ascii=False));return 0
if __name__=="__main__":raise SystemExit(main())
