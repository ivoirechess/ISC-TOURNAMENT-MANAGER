import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {normalizedClubName} from "../src/ui/club-combobox.js";

const migration=fs.readFileSync("supabase/migrations/20260813120000_canonical_club_management.sql","utf8");
const data=fs.readFileSync("src/data.js","utf8");
const html=fs.readFileSync("index.html","utf8");

test("casse, accents, espaces et ponctuation convergent",()=>{
  const variants=["Ivoire Chess Club","IVOIRE CHESS CLUB","Ivoire-Chess Club","  Ivoire   Chess Club  "];
  assert.deepEqual(new Set(variants.map(normalizedClubName)),new Set(["ivoire chess club"]));
});

test("les créations concurrentes sont sérialisées et idempotentes",()=>{
  assert.match(migration,/pg_advisory_xact_lock\(hashtextextended\(normalized_slug,0\)\)/);
  assert.match(migration,/where c\.slug=normalized_slug for update/);
  assert.match(migration,/select c\.\* into found from public\.clubs/);
});

test("la création du joueur et son club canonique partagent une transaction",()=>{
  assert.match(migration,/create_player_with_club[\s\S]*resolve_or_create_club[\s\S]*insert into public\.players/);
  assert.match(migration,/values\(btrim\(p_name\),lower\(btrim\(p_name\)\),chosen\.id,chosen\.name/);
  assert.match(data,/export async function createPlayerWithClub/);
});

test("le rapprochement ne touche que les joueurs sans club_id et diagnostique les variantes",()=>{
  assert.match(migration,/club_reconciliation_diagnostics/);
  assert.match(migration,/where club_id is null and public\.slugify\(club\)=item\.slug/);
  assert.match(migration,/array_agg\(distinct p\.club/);
});

test("la gestion complète, les sélecteurs accessibles et la création invitation sont câblés",()=>{
  for(const wrapper of ["resolveOrCreateClub","createClub","updateClub","listClubsForAdministration","createPlayerWithClub"])assert.match(data,new RegExp(`export async function ${wrapper}`));
  assert.match(html,/id="club-dialog"/);assert.match(html,/id="admin-create-club"/);assert.match(html,/id="np-club" type="search"/);
});
