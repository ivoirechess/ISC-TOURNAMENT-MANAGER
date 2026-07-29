import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";

function run(input,content,period="2026-08") { const dir=mkdtempSync(join(tmpdir(),"fide-"));const source=join(dir,input);const output=join(dir,"out.json");writeFileSync(source,content,"utf8");const result=spawnSync("python3",["scripts/fide_civ.py","--input",source,"--output",output,"--period",period,"--dry-run"],{encoding:"utf8"});assert.equal(result.status,0,result.stderr);return JSON.parse(readFileSync(output,"utf8")); }

test("parse TXT filtre CIV, préserve les accents et convertit les ratings absents",()=>{const data=run("players.txt","fide_id;name;title;fed;standard;rapid;blitz\n123;Kouamé Élise;WFM;CIV;1900;;0\n456;Autre;FM;FRA;2100;2000;1900\n");assert.equal(data.players.length,1);assert.equal(data.players[0].name,"Kouamé Élise");assert.equal(data.players[0].rating_rapid,null);assert.equal(data.players[0].rating_blitz,null);assert.match(data.report.sha256,/^[a-f0-9]{64}$/)});
test("parse XML accepte les balises FIDE usuelles",()=>{const data=run("players.xml",`<?xml version="1.0" encoding="UTF-8"?><players><player><fideid>789</fideid><name>Aïcha N'Guessan</name><country>CIV</country><title>WIM</title><rating>2200</rating><rapid_rating></rapid_rating><blitz_rating>2100</blitz_rating></player></players>`);assert.equal(data.players[0].fide_id,789);assert.equal(data.players[0].rating_rapid,null)});
test("l'upsert ne mentionne jamais les champs locaux club ou notes",()=>{const source=readFileSync("scripts/fide_civ.py","utf8");const sql=source.slice(source.indexOf('return "insert into public.players'));assert.doesNotMatch(sql,/club_id|local_notes|\bclub\b/)});
