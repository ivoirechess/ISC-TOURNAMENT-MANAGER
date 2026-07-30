import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function run(input, content, { existing = null, batchSize = 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fide-"));
  const source = join(dir, input), output = join(dir, "out.json"), sql = join(dir, "seed.sql");
  writeFileSync(source, content, "utf8");
  const args = ["scripts/fide_civ.py", "--input", source, "--output", output, "--sql-output", sql,
    "--period", "2026-08", "--batch-size", String(batchSize), "--dry-run"];
  if (existing) { const path = join(dir, "existing.json"); writeFileSync(path, JSON.stringify(existing)); args.push("--existing", path); }
  const result = spawnSync("python3", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { data: JSON.parse(readFileSync(output, "utf8")), sql: readFileSync(sql, "utf8") };
}

test("la liste combinée filtre CIV, garde les accents et transforme les faux zéros en null", () => {
  const { data } = run("players.txt", "fide_id;name;title;fed;sex;birth_year;active;standard;rapid;blitz;wtit;otit\n123;Kouamé Élise d'Abidjan;WFM;CIV;F;1998;i;1900;;0;WIM;IA\n456;Autre;FM;FRA;M;1980;1;2100;2000;1900;;\n");
  assert.equal(data.players.length, 1);
  assert.deepEqual(data.players[0], { fide_id: 123, name: "Kouamé Élise d'Abidjan", federation: "CIV", fide_title: "WFM", other_titles: ["WIM", "IA"], sex: "F", birth_year: 1998, fide_active: false, rating_std: 1900, rating_rapid: null, rating_blitz: null, normalized_name: "kouame elise d abidjan" });
  assert.match(data.report.sha256, /^[a-f0-9]{64}$/);
});

test("XML conserve les trois cadences, les apostrophes et les joueurs non classés", () => {
  const { data } = run("players.xml", `<?xml version="1.0"?><players><player><fideid>789</fideid><name>Aïcha N'Guessan</name><country>CIV</country><title>WIM</title><sex>F</sex><birthday>2001</birthday><rating>0</rating><rapid_rating></rapid_rating><blitz_rating>2100</blitz_rating><flag>i</flag></player></players>`);
  assert.equal(data.players[0].name, "Aïcha N'Guessan");
  assert.equal(data.players[0].rating_std, null);
  assert.equal(data.players[0].rating_rapid, null);
  assert.equal(data.players[0].rating_blitz, 2100);
  assert.equal(data.players[0].fide_active, false);
});

test("le seed est transactionnel, par lots et ne met à jour aucun champ local", () => {
  const rows = "fide_id;name;fed;standard;rapid;blitz\n1;Un;CIV;1;;;\n2;Deux;CIV;;2;;\n3;Trois;CIV;;;3\n";
  const { sql } = run("players.txt", rows, { batchSize: 2 });
  assert.match(sql, /^begin;/);
  assert.match(sql, /on conflict\(fide_id\) do update set/);
  assert.match(sql, /insert into public\.fide_import_reports/);
  assert.match(sql, /commit;\s*$/);
  assert.equal((sql.match(/insert into fide_civ_stage/g) || []).length, 2);
  const update = sql.slice(sql.indexOf("on conflict(fide_id)"), sql.indexOf("insert into public.fide_import_reports"));
  assert.doesNotMatch(update, /club_id|local_notes|\bclub\b|birth_year|\bsex\b/);
});

test("détecte les IDs répétés et suggère sans fusionner un homonyme manuel", () => {
  const source = "fide_id;name;fed;birth_year;standard\n10;Élise Kouamé;CIV;1998;1900\n10;Élise Kouamé;CIV;1998;1900\n11;N'Guessan Aïcha;CIV;2001;1800\n";
  const existing = [{ id: "manual", name: "Aicha N Guessan", fide_id: null, birth_year: 2001, rating_std: 1810, club: "Club local" }, { id: "fide", name: "Elise Kouame", fide_id: 10, club: "À préserver" }];
  const { data, sql } = run("players.txt", source, { existing });
  assert.deepEqual(data.report.duplicate_fide_ids, [10]);
  assert.deepEqual(data.reconciliation.exact_fide_ids, [10]);
  assert.deepEqual(data.reconciliation.new_fide_ids, [11]);
  assert.equal(data.reconciliation.potential_duplicates.length, 1);
  assert.equal(data.reconciliation.potential_duplicates[0].manual_player.club, "Club local");
  assert.ok(data.reconciliation.potential_duplicates[0].score >= 60);
  assert.doesNotMatch(sql, /merge_players/);
});

test("toutes les options d'exploitation sont documentées par --help", () => {
  const help = spawnSync("python3", ["scripts/fide_civ.py", "--help"], { encoding: "utf8" });
  for (const option of ["--input", "--download", "--period", "--dry-run", "--apply", "--output", "--sql-output", "--batch-size"]) assert.match(help.stdout, new RegExp(option));
});

test("la table d'audit conserve les compteurs et horodatages demandés", () => {
  const migration = readFileSync("supabase/migrations/20260811120000_fide_import_reports.sql", "utf8");
  for (const column of ["period", "source", "checksum", "rows_read", "civ_players", "players_created", "players_updated", "players_unchanged", "potential_duplicates", "errors", "started_at", "finished_at"]) assert.match(migration, new RegExp(`\\b${column}\\b`));
  assert.match(migration, /enable row level security/);
  assert.match(migration, /public\.is_super_admin\(\)/);
});
