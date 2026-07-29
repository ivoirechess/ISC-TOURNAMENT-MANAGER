import test from "node:test";
import assert from "node:assert/strict";
import { computeStandingsAfterRound } from "../src/tiebreaks.js";
import { canEnterResults, nextRoundAction, roundProgress } from "../src/round-entry.js";

const criteria = ["buchholz", "wins"];
const state = {
  players: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
  rounds: [
    { number: 1, released_at: "now", validated_at: "now", pairings: [
      { white: "a", black: "b", result: "1-0" },
      { white: "c", black: null, result: "bye" },
    ] },
    { number: 2, released_at: null, validated_at: null, pairings: [
      { white: "b", black: "c", result: "1-0" },
      { white: "a", black: null, result: "bye" },
    ] },
  ],
};

test("une ronde complète reste modifiable tant qu'elle n'est pas validée", () => {
  const round = { released_at: "now", validated_at: null, pairings: [{ result: "1-0" }] };
  assert.equal(roundProgress(round).complete, true);
  assert.equal(canEnterResults({ status: "ongoing" }, round).ok, true);
});

test("une ronde validée verrouille les résultats", () => {
  assert.match(canEnterResults({ status: "ongoing" }, state.rounds[0]).reason, /verrouillés/);
});

test("le classement après ronde 1 ignore résultat et bye futurs", () => {
  const rows = computeStandingsAfterRound(state, 1, criteria);
  assert.equal(rows.find((row) => row.playerId === "a").points, 1);
  assert.equal(rows.find((row) => row.playerId === "b").points, 0);
  assert.equal(rows.find((row) => row.playerId === "c").points, 1);
});

test("le bouton suisse suivant attend la validation", () => {
  const tournament = { status: "ongoing", format: "swiss", rounds_planned: 3 };
  assert.equal(nextRoundAction(tournament, [{ pairings: [{ result: "1-0" }], validated_at: null }]), null);
  assert.equal(nextRoundAction(tournament, [{ pairings: [{ result: "1-0" }], validated_at: "now" }]), "generate");
});
