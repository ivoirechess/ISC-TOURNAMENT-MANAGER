import test from "node:test";import assert from "node:assert/strict";
import {normalizePlayerFilters,playerIdentifier,publicTournaments,ratingLabel} from "../src/player-directory.js";
test("normalise filtres et pagination",()=>assert.deepEqual(normalizePlayerFilters({active:"bad",sort:"bad",page:"0",rated:"rated"}),{query:"",title:"",active:"",clubId:"",rated:"rated",sort:"rating_std",page:1}));
test("ratings zéro ou absents deviennent Non classé",()=>{assert.equal(ratingLabel(0),"Non classé");assert.equal(ratingLabel(null),"Non classé");assert.equal(ratingLabel(2012),"2012")});
test("identifiant FIDE prioritaire et tournois privés exclus",()=>{const p={id:"u",fide_id:123,tournament_players:[{tournaments:{id:"a",name:"Public",published_at:"x"}},{tournaments:{id:"b",name:"Privé",status:"draft"}}]};assert.equal(playerIdentifier(p),"123");assert.deepEqual(publicTournaments(p).map(t=>t.id),["a"])});
