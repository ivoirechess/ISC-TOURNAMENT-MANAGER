import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buchholz,
  buchholzCut1,
  sonnebornBerger,
  cumulative,
  wins,
  directEncounter,
  computeStandings,
  validateTiebreakSelection,
  TIEBREAK_KEYS,
} from "../src/tiebreaks.js";

// ---------------------------------------------------------------------------
// Tournoi A — 4 joueurs, 3 rondes, round-robin complet, aucun bye.
//
// Calendrier            Resultats
//   R1 : A-B, C-D         A bat B         C bat D
//   R2 : A-C, D-B         A annule C      D bat B
//   R3 : A-D, B-C         A bat D         B annule C
//
// Points, calcules a la main :
//   Alice   : 1   + 0.5 + 1   = 2.5
//   Bruno   : 0   + 0   + 0.5 = 0.5
//   Claire  : 1   + 0.5 + 0.5 = 2.0
//   Didier  : 0   + 1   + 0   = 1.0
//   Total 6 = 3 rondes x 2 parties x 1 point  ✔
// ---------------------------------------------------------------------------
const TOURNAMENT_A = {
  players: [
    { id: "a", name: "Alice" },
    { id: "b", name: "Bruno" },
    { id: "c", name: "Claire" },
    { id: "d", name: "Didier" },
  ],
  rounds: [
    {
      pairings: [
        { white: "a", black: "b", result: "1-0" },
        { white: "c", black: "d", result: "1-0" },
      ],
    },
    {
      pairings: [
        { white: "a", black: "c", result: "1/2-1/2" },
        { white: "d", black: "b", result: "1-0" },
      ],
    },
    {
      pairings: [
        { white: "a", black: "d", result: "1-0" },
        { white: "b", black: "c", result: "1/2-1/2" },
      ],
    },
  ],
};

describe("Tournoi A — chaque departage verifie contre le calcul manuel", () => {
  test("points", () => {
    const standings = computeStandings(TOURNAMENT_A, ["buchholz", "wins"]);
    const points = Object.fromEntries(standings.map((r) => [r.playerId, r.points]));
    assert.deepEqual(points, { a: 2.5, b: 0.5, c: 2.0, d: 1.0 });
  });

  test("buchholz — somme des scores des adversaires", () => {
    // Alice  : Bruno 0.5 + Claire 2.0 + Didier 1.0 = 3.5
    // Bruno  : Alice 2.5 + Didier 1.0 + Claire 2.0 = 5.5
    // Claire : Didier 1.0 + Alice 2.5 + Bruno 0.5  = 4.0
    // Didier : Claire 2.0 + Bruno 0.5 + Alice 2.5  = 5.0
    assert.equal(buchholz(TOURNAMENT_A, "a"), 3.5);
    assert.equal(buchholz(TOURNAMENT_A, "b"), 5.5);
    assert.equal(buchholz(TOURNAMENT_A, "c"), 4.0);
    assert.equal(buchholz(TOURNAMENT_A, "d"), 5.0);
  });

  test("buchholzCut1 — Buchholz moins l'adversaire le plus faible", () => {
    // Alice  : 3.5 - 0.5 (Bruno)  = 3.0
    // Bruno  : 5.5 - 1.0 (Didier) = 4.5
    // Claire : 4.0 - 0.5 (Bruno)  = 3.5
    // Didier : 5.0 - 0.5 (Bruno)  = 4.5
    assert.equal(buchholzCut1(TOURNAMENT_A, "a"), 3.0);
    assert.equal(buchholzCut1(TOURNAMENT_A, "b"), 4.5);
    assert.equal(buchholzCut1(TOURNAMENT_A, "c"), 3.5);
    assert.equal(buchholzCut1(TOURNAMENT_A, "d"), 4.5);
  });

  test("sonnebornBerger — score de l'adversaire x points pris contre lui", () => {
    // Alice  : Bruno 0.5x1 + Claire 2.0x0.5 + Didier 1.0x1   = 0.5 + 1.0 + 1.0   = 2.5
    // Bruno  : Alice 2.5x0 + Didier 1.0x0   + Claire 2.0x0.5 = 0   + 0   + 1.0   = 1.0
    // Claire : Didier 1.0x1 + Alice 2.5x0.5 + Bruno 0.5x0.5  = 1.0 + 1.25 + 0.25 = 2.5
    // Didier : Claire 2.0x0 + Bruno 0.5x1   + Alice 2.5x0    = 0   + 0.5 + 0     = 0.5
    assert.equal(sonnebornBerger(TOURNAMENT_A, "a"), 2.5);
    assert.equal(sonnebornBerger(TOURNAMENT_A, "b"), 1.0);
    assert.equal(sonnebornBerger(TOURNAMENT_A, "c"), 2.5);
    assert.equal(sonnebornBerger(TOURNAMENT_A, "d"), 0.5);
  });

  test("cumulative — somme des scores courants ronde apres ronde", () => {
    // Alice  : 1.0 + 1.5 + 2.5 = 5.0
    // Bruno  : 0   + 0   + 0.5 = 0.5
    // Claire : 1.0 + 1.5 + 2.0 = 4.5
    // Didier : 0   + 1.0 + 1.0 = 2.0
    assert.equal(cumulative(TOURNAMENT_A, "a"), 5.0);
    assert.equal(cumulative(TOURNAMENT_A, "b"), 0.5);
    assert.equal(cumulative(TOURNAMENT_A, "c"), 4.5);
    assert.equal(cumulative(TOURNAMENT_A, "d"), 2.0);
  });

  test("wins — nombre de parties gagnees", () => {
    // Alice : R1 et R3 = 2 ; Bruno : aucune = 0
    // Claire : R1 = 1      ; Didier : R2 = 1
    assert.equal(wins(TOURNAMENT_A, "a"), 2);
    assert.equal(wins(TOURNAMENT_A, "b"), 0);
    assert.equal(wins(TOURNAMENT_A, "c"), 1);
    assert.equal(wins(TOURNAMENT_A, "d"), 1);
  });

  test("classement final : aucun ex aequo, les points suffisent", () => {
    const standings = computeStandings(TOURNAMENT_A, ["buchholz", "sonnebornBerger"]);
    assert.deepEqual(standings.map((r) => r.playerId), ["a", "c", "d", "b"]);
    assert.deepEqual(standings.map((r) => r.rank), [1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// Tournoi B — 4 joueurs, 3 rondes, construit pour que deux joueurs restent
// a egalite jusqu'au Sonneborn-Berger.
//
// Calendrier            Resultats
//   R1 : A-B, C-D         A bat B         C bat D
//   R2 : A-C, D-B         A annule C      B bat D
//   R3 : A-D, B-C         D bat A         B bat C
//
// Points :
//   Alice  : 1   + 0.5 + 0 = 1.5
//   Bruno  : 0   + 1   + 1 = 2.0
//   Claire : 1   + 0.5 + 0 = 1.5
//   Didier : 0   + 0   + 1 = 1.0
//   Total 6  ✔
// ---------------------------------------------------------------------------
const TOURNAMENT_B = {
  players: [
    { id: "a", name: "Alice" },
    { id: "b", name: "Bruno" },
    { id: "c", name: "Claire" },
    { id: "d", name: "Didier" },
  ],
  rounds: [
    {
      pairings: [
        { white: "a", black: "b", result: "1-0" },
        { white: "c", black: "d", result: "1-0" },
      ],
    },
    {
      pairings: [
        { white: "a", black: "c", result: "1/2-1/2" },
        { white: "d", black: "b", result: "0-1" },
      ],
    },
    {
      pairings: [
        { white: "a", black: "d", result: "0-1" },
        { white: "b", black: "c", result: "1-0" },
      ],
    },
  ],
};

describe("Tournoi B — chaque departage verifie contre le calcul manuel", () => {
  test("points : Alice et Claire a egalite", () => {
    const standings = computeStandings(TOURNAMENT_B, ["buchholz", "sonnebornBerger"]);
    const points = Object.fromEntries(standings.map((r) => [r.playerId, r.points]));
    assert.deepEqual(points, { a: 1.5, b: 2.0, c: 1.5, d: 1.0 });
  });

  test("buchholz — ne separe pas Alice et Claire", () => {
    // Alice  : Bruno 2.0 + Claire 1.5 + Didier 1.0 = 4.5
    // Bruno  : Alice 1.5 + Didier 1.0 + Claire 1.5 = 4.0
    // Claire : Didier 1.0 + Alice 1.5 + Bruno 2.0  = 4.5
    // Didier : Claire 1.5 + Bruno 2.0 + Alice 1.5  = 5.0
    assert.equal(buchholz(TOURNAMENT_B, "a"), 4.5);
    assert.equal(buchholz(TOURNAMENT_B, "b"), 4.0);
    assert.equal(buchholz(TOURNAMENT_B, "c"), 4.5);
    assert.equal(buchholz(TOURNAMENT_B, "d"), 5.0);
  });

  test("buchholzCut1 — ne les separe pas non plus", () => {
    // Alice  : 4.5 - 1.0 (Didier) = 3.5
    // Claire : 4.5 - 1.0 (Didier) = 3.5
    // Bruno  : 4.0 - 1.0 (Didier) = 3.0
    // Didier : 5.0 - 1.5 (Alice ou Claire) = 3.5
    assert.equal(buchholzCut1(TOURNAMENT_B, "a"), 3.5);
    assert.equal(buchholzCut1(TOURNAMENT_B, "b"), 3.0);
    assert.equal(buchholzCut1(TOURNAMENT_B, "c"), 3.5);
    assert.equal(buchholzCut1(TOURNAMENT_B, "d"), 3.5);
  });

  test("sonnebornBerger — c'est lui qui tranche", () => {
    // Alice  : Bruno 2.0x1 + Claire 1.5x0.5 + Didier 1.0x0  = 2.0 + 0.75 + 0 = 2.75
    // Bruno  : Alice 1.5x0 + Didier 1.0x1   + Claire 1.5x1  = 0   + 1.0 + 1.5 = 2.5
    // Claire : Didier 1.0x1 + Alice 1.5x0.5 + Bruno 2.0x0   = 1.0 + 0.75 + 0 = 1.75
    // Didier : Claire 1.5x0 + Bruno 2.0x0   + Alice 1.5x1   = 0   + 0   + 1.5 = 1.5
    assert.equal(sonnebornBerger(TOURNAMENT_B, "a"), 2.75);
    assert.equal(sonnebornBerger(TOURNAMENT_B, "b"), 2.5);
    assert.equal(sonnebornBerger(TOURNAMENT_B, "c"), 1.75);
    assert.equal(sonnebornBerger(TOURNAMENT_B, "d"), 1.5);
  });

  test("cumulative — Alice et Claire encore a egalite", () => {
    // Alice  : 1.0 + 1.5 + 1.5 = 4.0
    // Bruno  : 0   + 1.0 + 2.0 = 3.0
    // Claire : 1.0 + 1.5 + 1.5 = 4.0
    // Didier : 0   + 0   + 1.0 = 1.0
    assert.equal(cumulative(TOURNAMENT_B, "a"), 4.0);
    assert.equal(cumulative(TOURNAMENT_B, "b"), 3.0);
    assert.equal(cumulative(TOURNAMENT_B, "c"), 4.0);
    assert.equal(cumulative(TOURNAMENT_B, "d"), 1.0);
  });

  test("wins — Alice et Claire encore a egalite", () => {
    // Alice : R1 = 1 ; Bruno : R2 et R3 = 2 ; Claire : R1 = 1 ; Didier : R3 = 1
    assert.equal(wins(TOURNAMENT_B, "a"), 1);
    assert.equal(wins(TOURNAMENT_B, "b"), 2);
    assert.equal(wins(TOURNAMENT_B, "c"), 1);
    assert.equal(wins(TOURNAMENT_B, "d"), 1);
  });

  test("directEncounter — Alice et Claire ont annule, egalite maintenue", () => {
    const values = directEncounter(TOURNAMENT_B, ["a", "c"]);
    assert.notEqual(values, null);
    assert.equal(values.get("a"), 0.5);
    assert.equal(values.get("c"), 0.5);
  });

  test("classement : le Buchholz ne tranche pas, le Sonneborn-Berger si", () => {
    const standings = computeStandings(TOURNAMENT_B, ["buchholz", "sonnebornBerger"]);
    assert.deepEqual(standings.map((r) => r.playerId), ["b", "a", "c", "d"]);
    assert.deepEqual(standings.map((r) => r.rank), [1, 2, 3, 4]);

    const alice = standings.find((r) => r.playerId === "a");
    assert.equal(alice.buchholz, 4.5);
    assert.equal(alice.sonnebornBerger, 2.75);
  });

  test("une colonne par departage choisi, dans l'ordre choisi", () => {
    const selected = ["wins", "cumulative", "buchholz"];
    const standings = computeStandings(TOURNAMENT_B, selected);
    for (const row of standings) {
      assert.deepEqual(
        Object.keys(row),
        ["playerId", "name", "points", "rank", ...selected]
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Tournoi C — 5 joueurs, 2 rondes, avec byes. Construit pour que TROIS
// joueurs finissent a egalite alors qu'une seule paire du groupe ne s'est
// jamais rencontree : la confrontation directe doit alors etre ignoree.
//
// Calendrier              Resultats
//   R1 : A-B, C-D, E exempt   A bat B      C annule D    E exempt (1 pt)
//   R2 : A-C, B-E, D exempt   C bat A      B bat E       D exempt (1 pt)
//
// Points :
//   Alice  : 1   + 0   = 1.0
//   Bruno  : 0   + 1   = 1.0
//   Claire : 0.5 + 1   = 1.5
//   Didier : 0.5 + 1   = 1.5   (bye)
//   Eva    : 1   + 0   = 1.0   (bye)
//
// Groupe a egalite sur 1.0 : Alice, Bruno, Eva.
//   Alice-Bruno : joue en R1     ✔
//   Bruno-Eva   : joue en R2     ✔
//   Alice-Eva   : jamais joue    ✘  -> confrontation directe inapplicable
// ---------------------------------------------------------------------------
const TOURNAMENT_C = {
  players: [
    { id: "a", name: "Alice" },
    { id: "b", name: "Bruno" },
    { id: "c", name: "Claire" },
    { id: "d", name: "Didier" },
    { id: "e", name: "Eva" },
  ],
  rounds: [
    {
      pairings: [
        { white: "a", black: "b", result: "1-0" },
        { white: "c", black: "d", result: "1/2-1/2" },
        { white: "e", black: null, result: "bye" },
      ],
    },
    {
      pairings: [
        { white: "a", black: "c", result: "0-1" },
        { white: "b", black: "e", result: "1-0" },
        { white: "d", black: null, result: "bye" },
      ],
    },
  ],
};

describe("Tournoi C — confrontation directe ignoree quand une paire manque", () => {
  test("points calcules a la main", () => {
    const standings = computeStandings(TOURNAMENT_C, ["directEncounter", "buchholz"]);
    const points = Object.fromEntries(standings.map((r) => [r.playerId, r.points]));
    assert.deepEqual(points, { a: 1.0, b: 1.0, c: 1.5, d: 1.5, e: 1.0 });
  });

  test("le groupe a trois est bien inapplicable : une paire ne s'est jamais rencontree", () => {
    assert.equal(directEncounter(TOURNAMENT_C, ["a", "b", "e"]), null);
  });

  test("mais les deux sous-paires ayant joue restent applicables", () => {
    const aliceBruno = directEncounter(TOURNAMENT_C, ["a", "b"]);
    assert.equal(aliceBruno.get("a"), 1);
    assert.equal(aliceBruno.get("b"), 0);

    const brunoEva = directEncounter(TOURNAMENT_C, ["b", "e"]);
    assert.equal(brunoEva.get("b"), 1);
    assert.equal(brunoEva.get("e"), 0);
  });

  test("buchholz avec adversaires virtuels pour les byes", () => {
    // n = 2 rondes jouees. Formule FIDE : Svon = SPR + (1 - SfPR) + 0.5 x (n - R)
    //
    // Alice  : Bruno 1.0 + Claire 1.5                     = 2.5
    // Bruno  : Alice 1.0 + Eva 1.0                        = 2.0
    // Eva    : bye en R1 -> Svon = 0 + (1-1) + 0.5x(2-1)  = 0.5
    //          Bruno 1.0 + 0.5                            = 1.5
    // Claire : Didier 1.5 + Alice 1.0                     = 2.5
    // Didier : bye en R2 -> Svon = 0.5 + (1-1) + 0.5x(2-2) = 0.5
    //          Claire 1.5 + 0.5                           = 2.0
    assert.equal(buchholz(TOURNAMENT_C, "a"), 2.5);
    assert.equal(buchholz(TOURNAMENT_C, "b"), 2.0);
    assert.equal(buchholz(TOURNAMENT_C, "e"), 1.5);
    assert.equal(buchholz(TOURNAMENT_C, "c"), 2.5);
    assert.equal(buchholz(TOURNAMENT_C, "d"), 2.0);
  });

  test("le groupe a trois est departage par le Buchholz, pas par la confrontation", () => {
    const standings = computeStandings(TOURNAMENT_C, ["directEncounter", "buchholz"]);
    // Claire et Didier (1.5) devant, puis le groupe a 1.0 trie au Buchholz :
    // Alice 2.5 > Bruno 2.0 > Eva 1.5
    assert.deepEqual(standings.map((r) => r.playerId), ["c", "d", "a", "b", "e"]);
    assert.deepEqual(standings.map((r) => r.rank), [1, 2, 3, 4, 5]);
  });

  test("la colonne confrontation directe est vide pour le groupe inapplicable", () => {
    const standings = computeStandings(TOURNAMENT_C, ["directEncounter", "buchholz"]);
    const byId = Object.fromEntries(standings.map((r) => [r.playerId, r]));

    // Groupe {a, b, e} : inapplicable -> null
    assert.equal(byId.a.directEncounter, null);
    assert.equal(byId.b.directEncounter, null);
    assert.equal(byId.e.directEncounter, null);

    // Groupe {c, d} : les deux se sont rencontres (nulle) -> 0.5 chacun
    assert.equal(byId.c.directEncounter, 0.5);
    assert.equal(byId.d.directEncounter, 0.5);
  });

  test("Claire et Didier sont bien departages par la confrontation directe", () => {
    // Ils ont annule : la confrontation ne tranche pas, le Buchholz prend le
    // relais (Claire 2.5 > Didier 2.0).
    const standings = computeStandings(TOURNAMENT_C, ["directEncounter", "buchholz"]);
    assert.deepEqual(standings.slice(0, 2).map((r) => r.playerId), ["c", "d"]);
  });
});

// ---------------------------------------------------------------------------
// Rencontres multiples : moyenne, jamais somme brute.
// ---------------------------------------------------------------------------
describe("confrontation directe — rencontres multiples", () => {
  // Aller-retour a 2 joueurs : Alice bat Bruno puis Bruno bat Alice.
  // Somme brute : 1 chacun. Moyenne : (1+0)/2 = 0.5 chacun. C'est la moyenne
  // qui doit sortir, pour qu'une paire jouee deux fois ne pese pas double.
  const DOUBLE = {
    players: [
      { id: "a", name: "Alice" },
      { id: "b", name: "Bruno" },
    ],
    rounds: [
      { pairings: [{ white: "a", black: "b", result: "1-0" }] },
      { pairings: [{ white: "b", black: "a", result: "1-0" }] },
    ],
  };

  test("deux rencontres partagees -> 0.5 de moyenne chacun", () => {
    const values = directEncounter(DOUBLE, ["a", "b"]);
    assert.equal(values.get("a"), 0.5);
    assert.equal(values.get("b"), 0.5);
  });

  test("deux victoires sur deux rencontres -> moyenne 1, pas somme 2", () => {
    const swept = {
      players: DOUBLE.players,
      rounds: [
        { pairings: [{ white: "a", black: "b", result: "1-0" }] },
        { pairings: [{ white: "b", black: "a", result: "0-1" }] },
      ],
    };
    const values = directEncounter(swept, ["a", "b"]);
    assert.equal(values.get("a"), 1);
    assert.equal(values.get("b"), 0);
  });
});

// ---------------------------------------------------------------------------
// Tournoi en cours : un round-robin ecrit TOUTES ses rondes des la creation,
// donc l'etat contient des rondes encore vides. Elles ne doivent peser sur
// aucun departage — c'est l'etat normal d'un tournoi « ongoing ».
// ---------------------------------------------------------------------------
describe("tournoi en cours — les rondes non jouees ne comptent pas", () => {
  const ONGOING = {
    players: [
      { id: "a", name: "Alice" },
      { id: "b", name: "Bruno" },
      { id: "c", name: "Claire" },
      { id: "d", name: "Didier" },
    ],
    rounds: [
      {
        pairings: [
          { white: "a", black: "b", result: "1-0" },
          { white: "c", black: "d", result: "1/2-1/2" },
        ],
      },
      // Rondes 2 et 3 : calendrier ecrit, aucun resultat.
      {
        pairings: [
          { white: "a", black: "c", result: null },
          { white: "d", black: "b", result: null },
        ],
      },
      {
        pairings: [
          { white: "a", black: "d", result: null },
          { white: "b", black: "c", result: null },
        ],
      },
    ],
  };

  test("les points ne comptent que la ronde jouee", () => {
    const standings = computeStandings(ONGOING, ["buchholz", "cumulative"]);
    const points = Object.fromEntries(standings.map((r) => [r.playerId, r.points]));
    assert.deepEqual(points, { a: 1, b: 0, c: 0.5, d: 0.5 });
  });

  test("le cumulatif ne repete pas le score sur les rondes a venir", () => {
    // Une seule ronde jouee : le cumulatif vaut le score apres cette ronde,
    // pas ce score repete pour chacune des trois rondes du calendrier.
    assert.equal(cumulative(ONGOING, "a"), 1);
    assert.equal(cumulative(ONGOING, "c"), 0.5);
    assert.equal(cumulative(ONGOING, "b"), 0);
  });

  test("un bye inscrit d'avance ne rapporte pas son point avant d'etre joue", () => {
    // Effectif impair : la ronde 2 porte deja son bye, mais aucune partie
    // n'y est jouee. Eva ne doit pas encaisser ce point maintenant.
    const withFutureBye = {
      players: [
        { id: "a", name: "Alice" },
        { id: "b", name: "Bruno" },
        { id: "e", name: "Eva" },
      ],
      rounds: [
        {
          pairings: [
            { white: "a", black: "b", result: "1-0" },
            { white: "e", black: null, result: "bye" },
          ],
        },
        {
          pairings: [
            { white: "a", black: "e", result: null },
            { white: "b", black: null, result: "bye" },
          ],
        },
      ],
    };
    const standings = computeStandings(withFutureBye, ["buchholz", "wins"]);
    const points = Object.fromEntries(standings.map((r) => [r.playerId, r.points]));
    // Eva garde le bye de la ronde 1 (jouee), Bruno n'a pas celui de la
    // ronde 2, qui n'a pas encore commence.
    assert.deepEqual(points, { a: 1, b: 0, e: 1 });
  });
});

// ---------------------------------------------------------------------------
// Filet alphabetique et validation de la selection.
// ---------------------------------------------------------------------------
describe("filet alphabetique", () => {
  // Deux joueurs strictement identiques sur tout : seul l'ordre alphabetique
  // peut encore trancher, et il doit le faire de facon deterministe.
  const PERFECT_TIE = {
    players: [
      { id: "z", name: "Zoe" },
      { id: "a", name: "Amara" },
    ],
    rounds: [
      { pairings: [{ white: "z", black: "a", result: "1/2-1/2" }] },
    ],
  };

  test("Amara passe devant Zoe malgre une egalite parfaite", () => {
    const standings = computeStandings(PERFECT_TIE, ["buchholz", "wins"]);
    assert.deepEqual(standings.map((r) => r.playerId), ["a", "z"]);
    assert.equal(standings[0].points, standings[1].points);
    assert.equal(standings[0].buchholz, standings[1].buchholz);
  });

  test("resultat stable d'un appel a l'autre", () => {
    const first = computeStandings(PERFECT_TIE, ["buchholz", "wins"]);
    const second = computeStandings(PERFECT_TIE, ["buchholz", "wins"]);
    assert.deepEqual(first, second);
  });
});

describe("validateTiebreakSelection", () => {
  test("accepte de 2 a 6 departages distincts", () => {
    assert.equal(validateTiebreakSelection(["buchholz", "wins"]).ok, true);
    assert.equal(validateTiebreakSelection(TIEBREAK_KEYS).ok, true);
    assert.equal(TIEBREAK_KEYS.length, 6);
  });

  test("refuse moins de deux, plus de six, les doublons et l'inconnu", () => {
    assert.equal(validateTiebreakSelection(["buchholz"]).ok, false);
    assert.equal(validateTiebreakSelection([]).ok, false);
    assert.equal(validateTiebreakSelection([...TIEBREAK_KEYS, "buchholz"]).ok, false);
    assert.equal(validateTiebreakSelection(["buchholz", "buchholz"]).ok, false);
    assert.equal(validateTiebreakSelection(["buchholz", "inconnu"]).ok, false);
    assert.equal(validateTiebreakSelection("buchholz").ok, false);
  });

  test("le domaine JS et la contrainte SQL ne divergent pas", () => {
    // La contrainte CHECK sur tournaments.tiebreaks rejetterait cote serveur
    // une cle ajoutee ici sans l'etre la-bas. Ce test lit la migration pour
    // que la derive se voie tout de suite, pas en production.
    const migration = readFileSync(
      new URL("../supabase/migrations/20260729120000_tournament_tiebreaks.sql", import.meta.url),
      "utf8"
    );
    // La recherche de fin part de l'index de debut : un `]::text[]` apparait
    // deja plus haut, dans la valeur DEFAULT.
    const start = migration.indexOf("tiebreaks <@ array[");
    assert.notEqual(start, -1, "domaine introuvable dans la migration");
    const domain = migration.slice(start, migration.indexOf("]::text[]", start));
    for (const key of TIEBREAK_KEYS) {
      assert.ok(domain.includes(`'${key}'`), `${key} absent du domaine SQL`);
    }
    const sqlKeys = [...domain.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(sqlKeys.sort(), [...TIEBREAK_KEYS].sort());
    // Les bornes 2..6 doivent elles aussi correspondre.
    assert.match(migration, /cardinality\(tiebreaks\) between 2 and 6/);
  });

  test("alphabetical n'est pas selectionnable", () => {
    assert.ok(!TIEBREAK_KEYS.includes("alphabetical"));
    assert.equal(validateTiebreakSelection(["buchholz", "alphabetical"]).ok, false);
  });

  test("computeStandings refuse une selection invalide", () => {
    assert.throws(() => computeStandings(TOURNAMENT_A, ["buchholz"]), /au moins deux/);
  });
});
