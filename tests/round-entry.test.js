import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ENTRY_CHOICES,
  GAME_RESULTS,
  canEnterResults,
  engineState,
  isEditablePairing,
  nextRoundAction,
  nextRoundLabel,
  progressLabel,
  resultClickAction,
  roundProgress,
  warningsConfirmation,
} from "../src/round-entry.js";
import { pairRound, isRoundComplete } from "../src/swiss.js";

function tournament(overrides = {}) {
  return {
    id: "t1",
    name: "Open",
    format: "swiss",
    rounds_planned: 3,
    status: "ongoing",
    ...overrides,
  };
}

function round(pairings, number = 1) {
  return { number, pairings };
}

const game = (result) => ({ id: "p1", board: 1, white: "a", black: "b", result });
const bye = () => ({ id: "p2", board: 2, white: "c", black: null, result: "bye" });

describe("roundProgress", () => {
  test("compte les resultats saisis, byes compris", () => {
    // Un bye porte son resultat des la creation : il compte comme saisi,
    // sinon la ronde ne serait jamais annoncee complete.
    const progress = roundProgress(round([game("1-0"), bye()]));
    assert.deepEqual(progress, { entered: 2, total: 2, complete: true });
  });

  test("une partie sans resultat laisse la ronde incomplete", () => {
    const progress = roundProgress(round([game("1-0"), game(null), bye()]));
    assert.equal(progress.entered, 2);
    assert.equal(progress.total, 3);
    assert.equal(progress.complete, false);
  });

  test("s'accorde avec isRoundComplete du moteur", () => {
    for (const pairings of [[game("1-0")], [game(null)], [game("0-1"), bye()]]) {
      assert.equal(roundProgress(round(pairings)).complete, isRoundComplete({ pairings }));
    }
  });

  test("ronde absente ou vide", () => {
    assert.deepEqual(roundProgress(undefined), { entered: 0, total: 0, complete: true });
    assert.deepEqual(roundProgress(round([])), { entered: 0, total: 0, complete: true });
  });
});

describe("progressLabel", () => {
  test("affiche « 4 / 5 résultats saisis »", () => {
    const pairings = [game("1-0"), game("0-1"), game("1/2-1/2"), bye(), game(null)];
    assert.equal(progressLabel(round(pairings)), "4 / 5 résultats saisis");
  });
});

describe("canEnterResults", () => {
  test("autorise sur un tournoi en cours", () => {
    assert.equal(canEnterResults(tournament()).ok, true);
  });

  test("refuse sur un brouillon et sur une archive", () => {
    assert.match(canEnterResults(tournament({ status: "draft" })).reason, /pas encore démarré/);
    assert.match(canEnterResults(tournament({ status: "archived" })).reason, /clôturé/);
  });

  test("refuse sans tournoi", () => {
    assert.equal(canEnterResults(null).ok, false);
  });
});

describe("isEditablePairing", () => {
  test("une vraie partie est saisissable", () => {
    assert.equal(isEditablePairing(game(null)), true);
    assert.equal(isEditablePairing(game("1-0")), true);
  });

  test("un bye ne l'est jamais", () => {
    assert.equal(isEditablePairing(bye()), false);
    // Meme si son resultat avait ete efface, l'absence d'adversaire suffit.
    assert.equal(isEditablePairing({ white: "c", black: null, result: null }), false);
  });

  test("entree manquante", () => {
    assert.equal(isEditablePairing(null), false);
  });
});

describe("resultClickAction", () => {
  test("un clic sur un autre bouton enregistre", () => {
    assert.equal(resultClickAction(game("1-0"), "0-1"), "set");
    assert.equal(resultClickAction(game(null), "1/2-1/2"), "set");
  });

  test("un clic sur le bouton actif annule", () => {
    // C'est le geste d'annulation demande : recliquer vide la case.
    assert.equal(resultClickAction(game("1-0"), "1-0"), "clear");
    assert.equal(resultClickAction(game("1/2-1/2"), "1/2-1/2"), "clear");
  });

  test("aucun effet sur un bye ni pour un choix hors domaine", () => {
    assert.equal(resultClickAction(bye(), "1-0"), null);
    assert.equal(resultClickAction(game(null), "bye"), null);
    assert.equal(resultClickAction(game(null), "2-0"), null);
  });

  test("les trois boutons couvrent exactement le domaine des resultats", () => {
    // L'ensemble doit correspondre ; l'ORDRE, lui, est propre a l'affichage.
    assert.deepEqual(
      [...ENTRY_CHOICES.map((c) => c.value)].sort(),
      [...GAME_RESULTS].sort()
    );
  });

  test("l'ordre d'affichage suit l'echiquier : blancs, nulle, noirs", () => {
    assert.deepEqual(ENTRY_CHOICES.map((c) => c.value), ["1-0", "1/2-1/2", "0-1"]);
    assert.deepEqual(ENTRY_CHOICES.map((c) => c.label), ["1-0", "½-½", "0-1"]);
  });
});

describe("nextRoundAction", () => {
  const complete = [round([game("1-0")], 1)];
  const incomplete = [round([game(null)], 1)];

  test("rien tant que la ronde en cours n'est pas finie", () => {
    assert.equal(nextRoundAction(tournament(), incomplete), null);
  });

  test("propose de generer la ronde suivante en suisse", () => {
    assert.equal(nextRoundAction(tournament(), complete), "generate");
  });

  test("propose de cloturer quand toutes les rondes prevues sont jouees", () => {
    const rounds = [
      round([game("1-0")], 1),
      round([game("1-0")], 2),
      round([game("1-0")], 3),
    ];
    assert.equal(nextRoundAction(tournament({ rounds_planned: 3 }), rounds), "archive");
  });

  test("ne propose jamais de generer en toutes rondes : le calendrier existe deja", () => {
    for (const format of ["round_robin", "double_round_robin"]) {
      assert.equal(nextRoundAction(tournament({ format }), complete), null, format);
    }
  });

  test("mais propose bien de cloturer un toutes rondes termine", () => {
    const rounds = [round([game("1-0")], 1), round([game("1-0")], 2)];
    assert.equal(
      nextRoundAction(tournament({ format: "round_robin", rounds_planned: 2 }), rounds),
      "archive"
    );
  });

  test("rien hors d'un tournoi en cours", () => {
    for (const status of ["draft", "archived"]) {
      assert.equal(nextRoundAction(tournament({ status }), complete), null, status);
    }
  });

  test("un tournoi sans ronde propose la premiere", () => {
    assert.equal(nextRoundAction(tournament(), []), "generate");
  });

  test("libelles", () => {
    assert.equal(nextRoundLabel("generate"), "Générer la ronde suivante");
    assert.equal(nextRoundLabel("archive"), "Clôturer le tournoi");
    assert.equal(nextRoundLabel(null), null);
  });
});

describe("warningsConfirmation", () => {
  test("nomme chaque revanche forcee avant de valider", () => {
    const warnings = ["Revanche forcee : a et b se sont deja affrontes"];
    const message = warningsConfirmation(warnings);
    assert.ok(message.includes(warnings[0]));
    assert.match(message, /Enregistrer cette ronde malgré tout \?/);
  });
});

describe("engineState", () => {
  test("passe au moteur des joueurs actifs et les rondes jouees", () => {
    const players = [
      { id: "a", name: "Alice" },
      { id: "b", name: "Bruno", withdrawn: true },
    ];
    const state = engineState(players, [round([game("1-0")])]);
    // Le champ garde son nom : swiss.js filtre son effectif sur `withdrawn`,
    // le renommer laisserait apparier un joueur qui a quitte le tournoi.
    assert.deepEqual(state.players, [
      { id: "a", name: "Alice", withdrawn: false },
      { id: "b", name: "Bruno", withdrawn: true },
    ]);
    assert.deepEqual(state.rounds, [{ pairings: [{ white: "a", black: "b", result: "1-0" }] }]);
  });

  test("le moteur suisse accepte cet etat tel quel", () => {
    // Le point du module : ce que l'ecran passe a pairRound doit etre
    // exactement ce que le moteur attend, sans adaptation intermediaire.
    const players = [
      { id: "a", name: "Alice" },
      { id: "b", name: "Bruno" },
      { id: "c", name: "Claire" },
      { id: "d", name: "Didier" },
    ];
    const state = engineState(players, []);
    const { pairings, warnings } = pairRound(state);
    assert.equal(pairings.length, 2);
    assert.deepEqual(warnings, []);

    // Et une deuxieme ronde se genere a partir de la premiere.
    for (const pairing of pairings) pairing.result = "1-0";
    const next = pairRound(engineState(players, [{ pairings }]));
    assert.equal(next.pairings.length, 2);
  });

  test("un joueur retire n'est jamais apparie", () => {
    const players = [
      { id: "a", name: "Alice" },
      { id: "b", name: "Bruno" },
      { id: "c", name: "Claire" },
      { id: "d", name: "Didier", withdrawn: true },
    ];
    const { pairings } = pairRound(engineState(players, []));
    const paired = pairings.flatMap((p) => [p.white, p.black]).filter(Boolean);
    assert.ok(!paired.includes("d"), "le joueur retire ne doit pas etre apparie");
    // Trois joueurs actifs : une partie et un exempt.
    assert.equal(pairings.filter((p) => p.black === null).length, 1);
  });

  test("entrees absentes", () => {
    assert.deepEqual(engineState(undefined, undefined), { players: [], rounds: [] });
  });
});
