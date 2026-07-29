import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FORMATS,
  isFormatAvailable,
  isRoundRobin,
  imposedRoundCount,
  validateTournamentDraft,
} from "../src/tournament-validation.js";
import { maxRounds, recommendedRounds } from "../src/swiss.js";
import { scheduleLength } from "../src/roundrobin.js";

const VALID_DRAFT = {
  name: "Open de Cocody",
  format: "swiss",
  roundsPlanned: 5,
  playerCount: 16,
};

describe("formats", () => {
  test("les quatre formats du schema sont declares ; seule la Coupe reste fermee", () => {
    assert.deepEqual(
      FORMATS.map((f) => f.value).sort(),
      ["double_round_robin", "knockout", "round_robin", "swiss"]
    );
    assert.deepEqual(
      FORMATS.filter((f) => f.enabled).map((f) => f.value).sort(),
      ["double_round_robin", "round_robin", "swiss"]
    );
  });

  test("isFormatAvailable", () => {
    assert.equal(isFormatAvailable("swiss"), true);
    assert.equal(isFormatAvailable("round_robin"), true);
    assert.equal(isFormatAvailable("double_round_robin"), true);
    assert.equal(isFormatAvailable("knockout"), false);
    assert.equal(isFormatAvailable("inconnu"), false);
  });

  test("isRoundRobin ne couvre que les deux formats en cercle", () => {
    assert.equal(isRoundRobin("round_robin"), true);
    assert.equal(isRoundRobin("double_round_robin"), true);
    assert.equal(isRoundRobin("swiss"), false);
    assert.equal(isRoundRobin("knockout"), false);
  });
});

describe("imposedRoundCount", () => {
  test("null pour le suisse : l'organisateur choisit", () => {
    assert.equal(imposedRoundCount("swiss", 10), null);
    assert.equal(imposedRoundCount("knockout", 10), null);
  });

  test("suit exactement le calendrier du cercle", () => {
    for (let n = 2; n <= 20; n++) {
      assert.equal(imposedRoundCount("round_robin", n), scheduleLength(n));
      assert.equal(
        imposedRoundCount("double_round_robin", n),
        scheduleLength(n, { doubled: true })
      );
    }
  });

  test("null quand l'effectif est insuffisant", () => {
    assert.equal(imposedRoundCount("round_robin", 1), null);
    assert.equal(imposedRoundCount("round_robin", undefined), null);
  });
});

describe("validateTournamentDraft - formats en cercle", () => {
  test("accepte le nombre de rondes impose, pour les deux formats", () => {
    for (let n = 4; n <= 16; n++) {
      for (const format of ["round_robin", "double_round_robin"]) {
        const roundsPlanned = imposedRoundCount(format, n);
        const result = validateTournamentDraft({
          ...VALID_DRAFT,
          format,
          playerCount: n,
          roundsPlanned,
        });
        assert.equal(result.ok, true, `${format}, n=${n}, rondes=${roundsPlanned}`);
        assert.deepEqual(result.warnings, []);
      }
    }
  });

  test("refuse tout autre nombre de rondes", () => {
    const imposed = imposedRoundCount("round_robin", 6); // 5
    for (const roundsPlanned of [imposed - 1, imposed + 1]) {
      const result = validateTournamentDraft({
        ...VALID_DRAFT,
        format: "round_robin",
        playerCount: 6,
        roundsPlanned,
      });
      assert.equal(result.ok, false, `rondes=${roundsPlanned} devrait etre refuse`);
      assert.ok(result.errors.some((e) => e.includes("toutes les rencontres")));
    }
  });

  test("le garde-fou du suisse ne s'applique pas au cercle", () => {
    // 10 joueurs : le suisse plafonne a 8 rondes, un round-robin en compte 9.
    const swissBlocked = validateTournamentDraft({
      ...VALID_DRAFT,
      format: "swiss",
      playerCount: 10,
      roundsPlanned: 9,
    });
    assert.equal(swissBlocked.ok, false);

    const roundRobinFine = validateTournamentDraft({
      ...VALID_DRAFT,
      format: "round_robin",
      playerCount: 10,
      roundsPlanned: 9,
    });
    assert.equal(roundRobinFine.ok, true);
  });

  test("la Coupe reste refusee", () => {
    const result = validateTournamentDraft({ ...VALID_DRAFT, format: "knockout" });
    assert.equal(result.ok, false);
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

  test("un format desactive est refuse pour indisponibilite, pas pour autre chose", () => {
    const result = validateTournamentDraft({ ...VALID_DRAFT, format: "knockout" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("pas encore disponible")));
  });

  test("un format inconnu est refuse", () => {
    const result = validateTournamentDraft({ ...VALID_DRAFT, format: "inconnu" });
    assert.equal(result.ok, false);
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
