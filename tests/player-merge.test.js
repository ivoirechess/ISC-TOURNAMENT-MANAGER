import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {invertedPlayerName,normalizedPlayerName,preferredMergeTarget,previewPlayerMerge} from "../src/player-merge.js";

const manual={id:"manual",name:"Aïcha N'Guessan",club:"Cavalier",local_notes:"note manuelle",rating_std:1800};
const fide={id:"fide",name:"N'GUESSAN Aicha",fide_id:123,federation:"CIV",fide_title:"WFM",rating_std:1900,rating_rapid:1850,local_notes:"note FIDE"};

test("normalise accents, apostrophes et ordre inverse",()=>{assert.equal(normalizedPlayerName(manual.name),"aicha n guessan");assert.equal(invertedPlayerName(manual.name),"guessan n aicha")});
test("manuel vers FIDE conserve identité officielle, club, notes et alias",()=>{const merged=previewPlayerMerge(manual,fide);assert.equal(merged.fide_id,123);assert.equal(merged.rating_std,1900);assert.equal(merged.club,"Cavalier");assert.match(merged.local_notes,/note FIDE\nnote manuelle/);assert.deepEqual(merged.aliases,[manual.name,fide.name])});
test("propose la fiche FIDE et interdit de la perdre",()=>{assert.equal(preferredMergeTarget(manual,fide),fide);assert.throws(()=>previewPlayerMerge(fide,manual),/fiche FIDE/)});
test("un choix local explicite gagne sans modifier les ratings FIDE",()=>{const merged=previewPlayerMerge(manual,fide,{club:"Éléphant"});assert.equal(merged.club,"Éléphant");assert.equal(merged.rating_std,1900)});

test("migration additive transfère sans supprimer et journalise les conflits",()=>{const sql=readFileSync("supabase/migrations/20260812120000_safe_player_merge.sql","utf8");for(const expected of [/create table public\.player_aliases/,/create table public\.player_merge_log/,/delete from public\.tournament_players/,/exists\(select 1 from public\.tournament_players/,/update public\.tournament_players set player_id=target_id/,/update public\.pairings set white_player_id=target_id/,/update public\.pairings set black_player_id=target_id/,/update public\.players set merged_into=target_id/,/insert into public\.player_merge_log/,/conflit historique dans une meme ronde/,/Seul un super-admin/,/deja fusionne/])assert.match(sql,expected);assert.doesNotMatch(sql,/delete from public\.players/)});
test("ancienne URL redirige et annuaire masque les sources tout en cherchant les alias",()=>{const data=readFileSync("src/data.js","utf8");assert.match(data,/if\(data\?\.merged_into\).*getPlayerProfile\(data\.merged_into\)/);assert.match(data,/\.is\("merged_into",null\)/);assert.match(data,/from\("player_aliases"\).*\.ilike\("alias"/s)});
test("UI passe exclusivement par les wrappers data",()=>{const data=readFileSync("src/data.js","utf8"),players=readFileSync("src/ui/players.js","utf8"),form=readFileSync("src/ui/tournament-form.js","utf8");for(const name of ["findPlayerDuplicates","previewPlayerMerge","mergePlayers"])assert.match(data,new RegExp(`function ${name}`));assert.doesNotMatch(players,/supabase|createClient/);assert.doesNotMatch(form,/supabase|createClient/)});
