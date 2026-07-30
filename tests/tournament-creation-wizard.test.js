import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/ui/tournament-form.js", import.meta.url), "utf8");
const data = readFileSync(new URL("../src/data.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260807120000_transactional_tournament_creation.sql", import.meta.url), "utf8");

test("l'assistant expose les sept étapes dans l'ordre", () => {
  for (const label of ["Informations générales", "Format et cadence", "Départages", "Joueurs", "Vérification", "Enregistrement", "Publication facultative"]) assert.match(ui, new RegExp(label));
  assert.equal((html.match(/class="wizard-page"/g) ?? []).length, 7);
});

test("tous les champs demandés sont câblés", () => {
  for (const id of ["t-name","t-description","t-starts","t-city","t-venue","t-address","t-organizer","t-contact","t-poster","t-formats","t-cadence","t-time-control","t-ranking","t-fide-rated","t-max-players","t-rounds","tiebreak-selects","player-list"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /id="t-registration"/);
});

test("le navigateur effectue une seule RPC et protège le double clic", () => {
  const fn = data.slice(data.indexOf("export async function createTournament"), data.indexOf("/**\n * All tournaments"));
  assert.match(fn, /client\.rpc\("create_tournament_with_players"/);
  assert.doesNotMatch(fn, /\.from\("tournaments"\)\.insert/);
  assert.match(ui, /if \(submitting \|\| !refreshValidation\(\)\) return/);
  assert.match(ui, /requestId/);
});

test("la RPC est transactionnelle, idempotente et valide le JSON serveur", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /tournament_creation_requests/);
  assert.match(migration, /Un joueur apparait plusieurs fois/);
  assert.match(migration, /tables uniques|board_index|unique/i);
  assert.match(migration, /Bye incoherent/);
  assert.match(migration, /Un resultat initial est interdit/);
  assert.match(migration, /Un tournoi suisse demarre sans ronde/);
  assert.match(migration, /comment on function public\.create_tournament_with_players/);
});
