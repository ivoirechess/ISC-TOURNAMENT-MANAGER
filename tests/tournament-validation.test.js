import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FORMATS,
  isFormatAvailable,
  validateTournamentDraft,
} from "../src/tournament-validation.js";
import { maxRounds, recommendedRounds } from "../src/swiss.js";

const VALID_DRAFT = {
  name: "Open de Cocody",
  format: "swiss",
  roundsPlanned: 5,
  playerCount: 16,
};

describe("formats", () => {
  test("les quatre formats du schema sont declares, seul le suisse est ouvert", () => {
    assert.deepEqual(
      FORMATS.map((f) => f.value).sort(),
      ["double_round_robin", "knockout", "round_robin", "swiss"]
    );
    assert.deepEqual(FORMATS.filter((f) => f.enabled).map((f) => f.value), ["swiss"]);
  });

  test("isFormatAvailable", () => {
    assert.equal(isFormatAvailable("swiss"), true);
    assert.equal(isFormatAvailable("round_robin"), false);
    assert.equal(isFormatAvailable("inconnu"), false);
  });
});

describe("validateTournamentDraft", () => {
  test("brouillon valide : ok, ni erreur ni avertissement", () => {
    const result = validateTournamentDraft({ ...VALID_DRAFT, roundsPlanned: 4 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  test("nom obligatoire", () => {
    for (const name of ["", "   ", undefined]) {
      const result = validateTournamentDraft({ ...VALID_DRAFT, name });
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes("nom du tournoi")));
    }
  });

  test("les formats desactives sont refuses a la validation aussi", () => {
    for (const format of ["round_robin", "knockout", "double_round_robin"]) {
      const result = validateTournamentDraft({ ...VALID_DRAFT, format });
      assert.equal(result.ok, false, `format ${format} devrait etre refuse`);
    }
  });

  test("nombre de rondes : entier >= 1 exige", () => {
    for (const roundsPlanned of [0, -1, 2.5, NaN, undefined]) {
      const result = validateTournamentDraft({ ...VALID_DRAFT, roundsPlanned });
      assert.equal(result.ok, false);
    }
  });

  test("au moins deux joueurs", () => {
    for (const playerCount of [0, 1]) {
      const result = validateTournamentDraft({ ...VALID_DRAFT, playerCount });
      assert.equal(result.ok, false);
      assert.ok(result.errors.some((e) => e.includes("deux joueurs")));
    }
  });

  test("depasser le maximum de rondes est une erreur bloquante", () => {
    // 4 joueurs -> maxRounds = 2 ; 6 rondes demandees -> bloque.
    const result = validateTournamentDraft({
      ...VALID_DRAFT,
      playerCount: 4,
      roundsPlanned: 6,
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("Toutes rondes")));
    assert.ok(result.errors.some((e) => e.includes(`${maxRounds(4)}`)));
  });

  test("sous le recommande : avertissement non bloquant", () => {
    // 16 joueurs -> recommande ceil(log2(16)) = 4 ; 2 rondes -> avertissement.
    const result = validateTournamentDraft({
      ...VALID_DRAFT,
      playerCount: 16,
      roundsPlanned: 2,
    });
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes(`${recommendedRounds(16)}`));
  });

  test("le garde-fou suit exactement le moteur sur toute la plage", () => {
    for (let n = 2; n <= 24; n++) {
      const max = maxRounds(n);
      if (max >= 1) {
        const atMax = validateTournamentDraft({ ...VALID_DRAFT, playerCount: n, roundsPlanned: max });
        assert.equal(atMax.ok, true, `n=${n}, rondes=${max} devrait passer`);
      }
      const overMax = validateTournamentDraft({ ...VALID_DRAFT, playerCount: n, roundsPlanned: max + 1 });
      assert.equal(overMax.ok, false, `n=${n}, rondes=${max + 1} devrait etre bloque`);
    }
  });
});
