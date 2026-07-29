import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canShowOrganizerPanel,
  initialRanking,
  primaryRating,
  resolveTournamentTab,
  tournamentProgress,
  tournamentTabUrl,
} from "../src/tournament-page.js";
import { lifecycleState } from "../src/tournament-lifecycle.js";

test("onglets partageables et repli vers Aperçu", () => {
  assert.equal(resolveTournamentTab("players"), "players");
  assert.equal(resolveTournamentTab("inconnu"), "overview");
  assert.equal(tournamentTabUrl("open-abidjan", "pairings", 4), "#/tournoi/open-abidjan?onglet=pairings&ronde=4");
  assert.equal(tournamentTabUrl("uuid", "overview"), "#/tournoi/uuid");
});

test("rang initial et Elo principal suivent la cadence", () => {
  const players = [
    { id: "a", name: "Alpha", rating_std: 2100, rating_rapid: 0 },
    { id: "b", name: "Bravo", rating_std: 1800, rating_rapid: 1950 },
  ];
  assert.equal(primaryRating(players[0], "rapid"), null);
  assert.deepEqual(initialRanking(players, "rapid").map((player) => [player.id, player.elo]), [["b", 1950], ["a", null]]);
  assert.deepEqual(initialRanking(players, "standard").map((player) => player.id), ["a", "b"]);
});

test("progression et prochaine ronde utilisent les validations", () => {
  const progress = tournamentProgress({ rounds_planned: 5 }, [
    { number: 1, released_at: "x", validated_at: "x" },
    { number: 2, released_at: "x", validated_at: null },
  ]);
  assert.deepEqual(progress, { validated: 1, planned: 5, percent: 20, nextRound: 2 });
});

test("seul le propriétaire ou le super-admin voit le panneau organisateur", () => {
  const tournament = { created_by: "owner" };
  assert.equal(canShowOrganizerPanel(tournament, "admin", "owner"), true);
  assert.equal(canShowOrganizerPanel(tournament, "admin", "other"), false);
  assert.equal(canShowOrganizerPanel(tournament, "super_admin", "other"), true);
  assert.equal(canShowOrganizerPanel(tournament, null, null), false);
});

test("un administrateur actif voit le panneau des tournois de son club",()=>{
  assert.equal(canShowOrganizerPanel({created_by:"other",club_id:"club-a"},"admin","admin-a",["club-a"]),true);
  assert.equal(canShowOrganizerPanel({created_by:"other",club_id:"club-b"},"admin","admin-a",["club-a"]),false);
});

test("les pages des tournois annulés et terminés gardent leur état public", () => {
  assert.equal(lifecycleState({ status: "ongoing", cancelled_at: "x" }), "cancelled");
  assert.equal(lifecycleState({ status: "archived", finished_at: "x" }), "finished");
});

test("la couche de données accepte slug et UUID sans caster un slug en uuid", () => {
  const source = readFileSync(new URL("../src/data.js", import.meta.url), "utf8");
  assert.match(source, /isUuid \? query\.eq\("id", id\) : query\.eq\("slug", id\)/);
  assert.match(source, /players\(id, name, title, fide_id, federation, club/);
});
