import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const html=readFileSync("index.html","utf8");
const tournamentPage=readFileSync("src/ui/tournament-page.js","utf8");
const tournamentForm=readFileSync("src/ui/tournament-form.js","utf8");
const data=readFileSync("src/data.js","utf8");
const schema=readFileSync("supabase/migrations/20260728120000_initial_schema.sql","utf8");

test("aucun visiteur ne reçoit un appel à l'inscription ou à la création de compte",()=>{
  assert.doesNotMatch(html,/S’inscrire|S'inscrire|Créer un compte|créer un compte|S’inscrire gratuitement/);
  assert.doesNotMatch(html,/overview-registration|t-registration/);
  assert.match(html,/Connexion organisateur/);
  assert.doesNotMatch(html,/sign[- ]?up|signup/i);
});

test("les anciennes registration_url ne sont ni sélectionnées ni affichées",()=>{
  assert.doesNotMatch(tournamentPage,/registration_url|overview-registration/);
  const results=data.slice(data.indexOf("export async function getTournamentResults"));
  assert.doesNotMatch(results,/registration_url/);
  const create=data.slice(data.indexOf("export async function createTournament"),data.indexOf("export async function listTournaments"));
  assert.doesNotMatch(create,/registration_url|registrationUrl/);
});

test("l'ajout manuel et la sélection administrateur restent câblés",()=>{
  assert.match(html,/Ajouter un joueur à l['’]annuaire/);
  assert.match(html,/id="player-search"/);
  assert.match(html,/id="player-list"/);
  assert.match(tournamentForm,/findPlayerDuplicates/);
  assert.match(tournamentForm,/createPlayer/);
  assert.match(tournamentForm,/selected\.add\(player\.id\)/);
});

test("RLS interdit au public d'insérer joueurs et participants",()=>{
  assert.match(schema,/create policy "admins insert players"[\s\S]*to authenticated[\s\S]*public\.is_admin\(\)/);
  assert.match(schema,/create policy "owner or super_admin inserts tournament_players"[\s\S]*to authenticated/);
  assert.doesNotMatch(schema,/create policy[^;]+on public\.players for insert[^;]+to anon/);
  assert.doesNotMatch(schema,/create policy[^;]+on public\.tournament_players for insert[^;]+to anon/);
});
