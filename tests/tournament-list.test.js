import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { STATUS_LABELS, groupTournaments, playerCount } from "../src/tournament-list.js";

function row(id, status, createdAt) {
  return { id, name: `Tournoi ${id}`, status, created_at: createdAt };
}

describe("groupTournaments", () => {
  test("repartit ongoing et draft dans En cours, archived dans Archives", () => {
    const { current, archives } = groupTournaments([
      row("a", "ongoing", "2026-07-01T10:00:00Z"),
      row("b", "archived", "2026-06-01T10:00:00Z"),
      row("c", "draft", "2026-07-02T10:00:00Z"),
    ]);
    assert.deepEqual(current.map((t) => t.id), ["c", "a"]);
    assert.deepEqual(archives.map((t) => t.id), ["b"]);
  });

  test("trie chaque section par date la plus recente d'abord", () => {
    const { current, archives } = groupTournaments([
      row("vieux", "ongoing", "2026-01-01T00:00:00Z"),
      row("recent", "draft", "2026-07-01T00:00:00Z"),
      row("moyen", "ongoing", "2026-04-01T00:00:00Z"),
      row("arch-vieux", "archived", "2025-01-01T00:00:00Z"),
      row("arch-recent", "archived", "2025-12-01T00:00:00Z"),
    ]);
    assert.deepEqual(current.map((t) => t.id), ["recent", "moyen", "vieux"]);
    assert.deepEqual(archives.map((t) => t.id), ["arch-recent", "arch-vieux"]);
  });

  test("ordre deterministe a date identique, statut inconnu ignore", () => {
    const sameDate = "2026-07-01T00:00:00Z";
    const { current, archives } = groupTournaments([
      row("b", "ongoing", sameDate),
      row("a", "ongoing", sameDate),
      row("x", "cancelled", sameDate),
    ]);
    assert.deepEqual(current.map((t) => t.id), ["a", "b"]);
    assert.deepEqual(archives, []);
  });

  test("entree vide ou absente -> sections vides", () => {
    assert.deepEqual(groupTournaments([]), { current: [], archives: [] });
    assert.deepEqual(groupTournaments(undefined), { current: [], archives: [] });
  });
});

describe("playerCount", () => {
  test("lit l'agregat PostgREST [{count}]", () => {
    assert.equal(playerCount({ tournament_players: [{ count: 12 }] }), 12);
  });

  test("0 par defaut sur forme absente ou inattendue", () => {
    assert.equal(playerCount({}), 0);
    assert.equal(playerCount({ tournament_players: [] }), 0);
    assert.equal(playerCount({ tournament_players: [{}] }), 0);
    assert.equal(playerCount(undefined), 0);
  });
});

describe("STATUS_LABELS", () => {
  test("couvre exactement les trois statuts du schema, en francais", () => {
    assert.deepEqual(Object.keys(STATUS_LABELS).sort(), ["archived", "draft", "ongoing"]);
    assert.equal(STATUS_LABELS.ongoing, "En cours");
  });
});
