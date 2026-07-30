#!/usr/bin/env python3
"""Synchronize CIV players from the official combined monthly FIDE list."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.request
import zipfile
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from xml.etree import ElementTree as ET

DEFAULT_URL = "https://ratings.fide.com/download/players_list.zip"
FIDE_SOURCE = "FIDE combined rating list (STD/RPD/BLZ)"


def nullable_int(value):
    try:
        number = int(str(value or "").strip())
    except ValueError:
        return None
    return number if number > 0 else None


def normalize_name(name):
    plain = "".join(c for c in unicodedata.normalize("NFKD", name or "") if not unicodedata.combining(c))
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", plain.casefold()).split())


def name_forms(name):
    normalized = normalize_name(name)
    words = normalized.split()
    return {normalized, " ".join(reversed(words))} if len(words) > 1 else {normalized}


def active_value(value):
    value = str(value or "").strip().casefold()
    if not value:
        return None
    return value not in {"i", "inactive", "false", "0", "n"}


def record(fid, name, federation, title="", other_titles=None, sex="", birth_year="", active=None,
           standard="", rapid="", blitz=""):
    titles = [value.strip() for value in (other_titles or []) if value and value.strip()]
    sex = str(sex or "").strip().upper()
    return {
        "fide_id": int(fid), "name": name.strip(), "federation": federation.strip().upper(),
        "fide_title": title.strip() or None, "other_titles": titles,
        "sex": sex if sex in {"M", "F"} else None, "birth_year": nullable_int(birth_year),
        "fide_active": active, "rating_std": nullable_int(standard),
        "rating_rapid": nullable_int(rapid), "rating_blitz": nullable_int(blitz),
        "normalized_name": normalize_name(name),
    }


def field(row, *names):
    normalized = {re.sub(r"[^a-z0-9]", "", key.casefold()): value for key, value in row.items() if key is not None}
    for name in names:
        value = normalized.get(re.sub(r"[^a-z0-9]", "", name.casefold()))
        if value is not None:
            return value
    return ""


def parse_delimited(text):
    header = text.splitlines()[0]
    delimiter = max(";\t,", key=header.count)
    result = []
    for row in csv.DictReader(io.StringIO(text), delimiter=delimiter):
        federation = field(row, "fed", "federation", "country").upper()
        if federation != "CIV":
            continue
        result.append(record(
            field(row, "fide_id", "fideid", "id number", "id"), field(row, "name"), federation,
            field(row, "title", "tit"), [field(row, "w_title", "wtit"), field(row, "o_title", "otit")],
            field(row, "sex"), field(row, "birth_year", "birthday", "byear"),
            active_value(field(row, "active", "flag")), field(row, "standard", "rating", "srtng"),
            field(row, "rapid", "rapid_rating", "rrtng"), field(row, "blitz", "blitz_rating", "brtng"),
        ))
    return result


def fixed_columns(header):
    matches = list(re.finditer(r"\S+", header))
    return [(match.group(), match.start(), matches[index + 1].start() if index + 1 < len(matches) else None)
            for index, match in enumerate(matches)]


def parse_txt(text):
    lines = [line.rstrip("\r\n") for line in text.splitlines() if line.strip()]
    if not lines:
        return []
    if any(delimiter in lines[0] for delimiter in ";\t,"):
        return parse_delimited("\n".join(lines))
    columns = fixed_columns(lines[0])
    result = []
    for line in lines[1:]:
        if lines[0].lstrip().startswith("ID Number") and len(line) >= 147:
            row = {
                "ID": line[0:15], "Name": line[15:76], "Fed": line[76:80], "Sex": line[80:84],
                "Tit": line[84:89], "WTit": line[89:94], "OTit": line[94:109],
                "SRtng": line[113:118], "RRtng": line[128:133], "BRtng": line[143:148],
                "B-day": line[158:163] if len(line) >= 163 else "", "Flag": line[163:167] if len(line) >= 167 else "",
            }
        else:
            row = {name: line[start:end].strip() for name, start, end in columns}
        federation = field(row, "Fed", "Federation").upper()
        fid = field(row, "ID", "ID Number", "FIDEID")
        if federation != "CIV" or not fid.isdigit():
            continue
        result.append(record(
            fid, field(row, "Name"), federation, field(row, "Tit", "Title"),
            [field(row, "WTit"), field(row, "OTit")], field(row, "Sex"), field(row, "B-day", "BYear"),
            active_value(field(row, "Flag", "Active")), field(row, "SRtng", "Rating"),
            field(row, "RRtng", "Rapid"), field(row, "BRtng", "Blitz"),
        ))
    return result


def xml_text(node, *names):
    for name in names:
        value = node.findtext(name)
        if value is not None:
            return value
    return ""


def parse_xml(data):
    result = []
    for node in ET.fromstring(data).findall(".//player"):
        federation = xml_text(node, "country", "federation", "fed").upper()
        if federation != "CIV":
            continue
        result.append(record(
            xml_text(node, "fideid", "fide_id", "id"), xml_text(node, "name"), federation,
            xml_text(node, "title"), [xml_text(node, "w_title", "wtitle"), xml_text(node, "o_title", "otitle")],
            xml_text(node, "sex"), xml_text(node, "birthday", "birth_year"),
            active_value(xml_text(node, "flag", "active")), xml_text(node, "rating", "standard_rating"),
            xml_text(node, "rapid_rating"), xml_text(node, "blitz_rating"),
        ))
    return result


def load_source(path):
    raw = Path(path).read_bytes()
    payload = raw
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            candidates = [name for name in archive.namelist() if name.lower().endswith((".xml", ".txt"))]
            if not candidates:
                raise ValueError("L'archive ne contient ni fichier XML ni fichier TXT.")
            payload = archive.read(candidates[0])
    if payload.lstrip().startswith(b"<"):
        total_rows = len(ET.fromstring(payload).findall(".//player"))
        players = parse_xml(payload)
    else:
        decoded = payload.decode("utf-8-sig", errors="replace")
        total_rows = max(0, len([line for line in decoded.splitlines() if line.strip()]) - 1)
        players = parse_txt(decoded)
    duplicates = sorted({p["fide_id"] for p in players if sum(x["fide_id"] == p["fide_id"] for x in players) > 1})
    unique = {player["fide_id"]: player for player in players}
    return list(unique.values()), raw, duplicates, total_rows


def load_existing(path=None):
    if path:
        content = json.loads(Path(path).read_text(encoding="utf-8"))
        return content.get("players", content) if isinstance(content, dict) else content
    url = os.environ.get("DATABASE_URL")
    if not url:
        return []
    query = "copy (select row_to_json(p) from public.players p where merged_into is null) to stdout"
    result = subprocess.run(["psql", url, "-Atc", query], text=True, capture_output=True, check=True)
    return [json.loads(line) for line in result.stdout.splitlines() if line]


def match_score(fide, manual):
    similarities = [SequenceMatcher(None, left, right).ratio() for left in name_forms(fide["name"]) for right in name_forms(manual.get("name", ""))]
    score = max(similarities, default=0) * 70
    reasons = [f"nom {max(similarities, default=0):.0%}"]
    if fide.get("birth_year") and fide["birth_year"] == manual.get("birth_year"):
        score += 15; reasons.append("année de naissance identique")
    if manual.get("club") and fide.get("club") and normalize_name(manual["club"]) == normalize_name(fide["club"]):
        score += 5; reasons.append("club identique")
    ratings = [key for key in ("rating_std", "rating_rapid", "rating_blitz") if fide.get(key) and manual.get(key)]
    if ratings and min(abs(fide[key] - manual[key]) for key in ratings) <= 30:
        score += 10; reasons.append("rating proche")
    return round(min(score, 100), 1), reasons


def reconcile(players, existing):
    by_fide = {int(row["fide_id"]): row for row in existing if row.get("fide_id")}
    manual = [row for row in existing if not row.get("fide_id")]
    exact, new, candidates = [], [], []
    for fide in players:
        if fide["fide_id"] in by_fide:
            exact.append(fide["fide_id"]); continue
        new.append(fide["fide_id"])
        for local in manual:
            score, reasons = match_score(fide, local)
            if score >= 60:
                candidates.append({"manual_player": local, "fide_player": fide, "score": score, "reasons": reasons})
    return {"new_fide_ids": new, "exact_fide_ids": exact, "potential_duplicates": candidates}


def quote(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def sql_array(values):
    return "array[" + ",".join(quote(value) for value in values) + "]::text[]"


def sql_document(players, report, batch_size):
    columns = "fide_id,name,federation,fide_title,other_titles,sex,birth_year,fide_active,rating_std,rating_rapid,rating_blitz,source_period,fide_synced_at,normalized_name,source"
    lines = ["begin;", "set local statement_timeout = 0;", "create temporary table fide_civ_stage (like public.players including defaults) on commit drop;"]
    for offset in range(0, len(players), batch_size):
        values = []
        for player in players[offset:offset + batch_size]:
            values.append("(" + ",".join([
                quote(player["fide_id"]), quote(player["name"]), quote(player["federation"]), quote(player["fide_title"]),
                sql_array(player["other_titles"]), quote(player["sex"]), quote(player["birth_year"]), quote(player["fide_active"]),
                quote(player["rating_std"]), quote(player["rating_rapid"]), quote(player["rating_blitz"]), quote(report["period"]),
                quote(report["synchronized_at"]), quote(player["normalized_name"]), quote(FIDE_SOURCE),
            ]) + ")")
        lines.append(f"insert into fide_civ_stage({columns}) values\n" + ",\n".join(values) + ";")
    lines.extend([
        "create temporary table fide_civ_counts as select count(*) filter(where p.id is null) created, count(*) filter(where p.id is not null and row(p.name,p.federation,p.fide_title,p.other_titles,p.fide_active,p.rating_std,p.rating_rapid,p.rating_blitz,p.source_period,p.normalized_name) is distinct from row(s.name,s.federation,s.fide_title,s.other_titles,s.fide_active,s.rating_std,s.rating_rapid,s.rating_blitz,s.source_period,s.normalized_name)) updated, count(*) filter(where p.id is not null and row(p.name,p.federation,p.fide_title,p.other_titles,p.fide_active,p.rating_std,p.rating_rapid,p.rating_blitz,p.source_period,p.normalized_name) is not distinct from row(s.name,s.federation,s.fide_title,s.other_titles,s.fide_active,s.rating_std,s.rating_rapid,s.rating_blitz,s.source_period,s.normalized_name)) unchanged from fide_civ_stage s left join public.players p using(fide_id);",
        "insert into public.players(" + columns + ") select " + columns + " from fide_civ_stage on conflict(fide_id) do update set name=excluded.name,federation=excluded.federation,fide_title=excluded.fide_title,other_titles=excluded.other_titles,fide_active=excluded.fide_active,rating_std=excluded.rating_std,rating_rapid=excluded.rating_rapid,rating_blitz=excluded.rating_blitz,source_period=excluded.source_period,fide_synced_at=excluded.fide_synced_at,normalized_name=excluded.normalized_name,source=excluded.source;",
        "insert into public.fide_import_reports(period,source,checksum,rows_read,civ_players,players_created,players_updated,players_unchanged,potential_duplicates,errors,started_at,finished_at) select " + ",".join([quote(report["period"]), quote(report["source"]), quote(report["sha256"]), quote(report["rows_read"]), quote(report["civ_players"]), "created", "updated", "unchanged", quote(report["potential_duplicates"]), quote(report["errors"]), quote(report["started_at"]), quote(report["synchronized_at"])]) + " from fide_civ_counts;",
        "commit;", "",
    ])
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input")
    source.add_argument("--download", nargs="?", const=DEFAULT_URL)
    parser.add_argument("--period", required=True, help="Période FIDE, au format YYYY-MM")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--output", required=True, help="Rapport JSON complet")
    parser.add_argument("--sql-output", help="Seed SQL autonome (recommandé: supabase/seeds/fide_civ_YYYY_MM.sql)")
    parser.add_argument("--batch-size", type=int, default=250)
    parser.add_argument("--existing", help="Export JSON des joueurs existants pour le rapprochement hors connexion DB")
    args = parser.parse_args(argv)
    if args.batch_size < 1:
        parser.error("--batch-size doit être positif")
    if args.apply and args.dry_run:
        parser.error("--apply et --dry-run sont incompatibles")
    started = datetime.now(timezone.utc).isoformat()
    if args.download:
        download_path = Path(args.output).with_suffix(".download.zip")
        urllib.request.urlretrieve(args.download, download_path)
        input_path = download_path
        source_label = args.download
    else:
        input_path = Path(args.input)
        source_label = str(input_path)
    players, raw, duplicate_ids, rows_read = load_source(input_path)
    existing = load_existing(args.existing)
    reconciliation = reconcile(players, existing)
    finished = datetime.now(timezone.utc).isoformat()
    report = {
        "period": args.period, "source": source_label, "sha256": hashlib.sha256(raw).hexdigest(),
        "rows_read": rows_read, "civ_players": len(players), "players_created": len(reconciliation["new_fide_ids"]),
        "players_updated": len(reconciliation["exact_fide_ids"]), "players_unchanged": None,
        "potential_duplicates": len(reconciliation["potential_duplicates"]), "duplicate_fide_ids": duplicate_ids,
        "errors": [], "started_at": started, "synchronized_at": finished,
    }
    document = {"report": report, "reconciliation": reconciliation, "players": players}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.sql_output:
        Path(args.sql_output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.sql_output).write_text(sql_document(players, report, args.batch_size), encoding="utf-8")
    if args.apply:
        if not args.sql_output:
            parser.error("--apply exige --sql-output")
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            raise SystemExit("DATABASE_URL est obligatoire avec --apply")
        subprocess.run(["psql", database_url, "-v", "ON_ERROR_STOP=1", "-f", args.sql_output], check=True)
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
