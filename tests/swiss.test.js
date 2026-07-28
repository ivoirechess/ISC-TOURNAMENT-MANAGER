import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  maxRounds,
  recommendedRounds,
  suggestedRounds,
  validateRoundCount,
  score,
  pairRound,
  isRoundComplete,
} from "../src/swiss.js";

// PRNG a graine (mulberry32) : reproductible, uniquement utilise dans les
// tests. Le moteur lui-meme n'utilise jamais Math.random().
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Joueur ${i + 1}` }));
}

const DECISIVE_RESULTS = ["1-0", "0-1", "1/2-1/2"];

function pointsForPairing(pairing) {
  if (pairing.result === "bye") return 1;
  if (pairing.result === "1-0" || pairing.result === "0-1") return 1;
  if (pairing.result === "1/2-1/2") return 1; // 0.5 + 0.5
  return 0;
}

// Genere une ronde, y assigne des resultats aleatoires reproductibles, et
// l'ajoute a l'etat. Partage par les differentes campagnes de test.
function playRandomRound(state, rng) {
  const { pairings, warnings } = pairRound(state);
  for (const pairing of pairings) {
    if (pairing.black === null) continue;
    pairing.result = DECISIVE_RESULTS[Math.floor(rng() * DECISIVE_RESULTS.length)];
  }
  state.rounds.push({ pairings });
  return { pairings, warnings };
}

// Ancien plafond (round-robin complet) : n-1 si pair, n si impair. Conserve
// dans les tests pour pousser volontairement le moteur dans la zone
// degradee (voir CLAUDE.md, section "limites assumees").
function oldMaxRounds(n) {
  if (n <= 1) return 0;
  return n % 2 === 0 ? n - 1 : n;
}

describe("garde-fou : nombre de rondes", () => {
  test("10 joueurs -> 8 rondes max (n-2, pair)", () => {
    assert.equal(maxRounds(10), 8);
  });

  test("11 joueurs -> 10 rondes max (n-1, impair)", () => {
    assert.equal(maxRounds(11), 10);
  });

  test("4 joueurs et 6 rondes demandees -> refuse", () => {
    const result = validateRoundCount(4, 6);
    assert.equal(result.max, 2);
    assert.equal(result.blocked, true);
    assert.match(result.message, /Toutes rondes/);
  });

  test("2 joueurs -> 0 ronde max en suisse (oriente vers Toutes rondes)", () => {
    assert.equal(maxRounds(2), 0);
    const result = validateRoundCount(2, 1);
    assert.equal(result.blocked, true);
  });

  test("recommendedRounds suit ceil(log2(n))", () => {
    assert.equal(recommendedRounds(8), 3);
    assert.equal(recommendedRounds(9), 4);
    assert.equal(recommendedRounds(2), 1);
  });

  test("suggestedRounds ne depasse jamais maxRounds", () => {
    for (let n = 2; n <= 32; n++) {
      assert.ok(suggestedRounds(n) <= maxRounds(n));
    }
  });

  test("validateRoundCount signale un avertissement sous le recommande, sans message", () => {
    const result = validateRoundCount(16, 2);
    assert.equal(result.warning, true);
    assert.equal(result.blocked, false);
    assert.equal(result.message, null);
  });
});

describe("isRoundComplete", () => {
  test("faux tant qu'un resultat manque", () => {
    const round = { pairings: [{ white: "p1", black: "p2", result: null }] };
    assert.equal(isRoundComplete(round), false);
  });

  test("vrai quand tout est renseigne, bye compris", () => {
    const round = {
      pairings: [
        { white: "p1", black: "p2", result: "1-0" },
        { white: "p3", black: null, result: "bye" },
      ],
    };
    assert.equal(isRoundComplete(round), true);
  });
});

describe("pairRound : cas de base", () => {
  test("4 joueurs, memes scores -> 2 parties, pas de bye, pas d'avertissement", () => {
    const state = { players: makePlayers(4), rounds: [] };
    const { pairings, warnings } = pairRound(state);
    assert.equal(pairings.length, 2);
    assert.ok(pairings.every((p) => p.black !== null));
    assert.deepEqual(warnings, []);
  });

  test("5 joueurs -> un bye attribue, pas d'avertissement", () => {
    const state = { players: makePlayers(5), rounds: [] };
    const { pairings, warnings } = pairRound(state);
    const byes = pairings.filter((p) => p.black === null);
    assert.equal(byes.length, 1);
    assert.equal(byes[0].result, "bye");
    assert.deepEqual(warnings, []);
  });

  test("refuse de generer une ronde si la precedente est incomplete", () => {
    const state = {
      players: makePlayers(4),
      rounds: [{ pairings: [{ white: "p1", black: "p2", result: null }, { white: "p3", black: "p4", result: "1-0" }] }],
    };
    assert.throws(() => pairRound(state));
  });

  test("un joueur retire (withdrawn) n'est plus apparie", () => {
    const players = makePlayers(5);
    players[0].withdrawn = true;
    const state = { players, rounds: [] };
    const { pairings, warnings } = pairRound(state);
    const ids = pairings.flatMap((p) => [p.white, p.black]).filter(Boolean);
    assert.ok(!ids.includes("p1"));
    // 4 joueurs actifs restants -> pas de bye
    assert.equal(pairings.some((p) => p.black === null), false);
    assert.deepEqual(warnings, []);
  });
});

describe("score", () => {
  test("calcule les points sur plusieurs rondes, byes compris", () => {
    const state = {
      players: makePlayers(3),
      rounds: [
        {
          pairings: [
            { white: "p1", black: "p2", result: "1-0" },
            { white: "p3", black: null, result: "bye" },
          ],
        },
        {
          pairings: [
            { white: "p2", black: "p3", result: "1/2-1/2" },
            { white: "p1", black: null, result: "bye" },
          ],
        },
      ],
    };
    assert.equal(score(state, "p1"), 2); // victoire (1) + bye (1)
    assert.equal(score(state, "p2"), 0.5); // defaite (0) + nulle (0.5)
    assert.equal(score(state, "p3"), 1.5); // bye (1) + nulle (0.5)
  });
});

describe("proprietes de l'appariement - campagne principale (plafond suisse)", () => {
  // Sous le nouveau plafond (maxRounds), la marge d'appariement depend de la
  // dynamique du tournoi (les scores et couleurs deja joues), pas seulement
  // de n : aucune formule statique sur n ne peut garantir zero revanche a la
  // derniere ronde pour un petit effectif. C'est une limite assumee (voir
  // CLAUDE.md) : un avertissement n'est tolere ici que sur la toute derniere
  // ronde autorisee, et seulement pour n <= 8. Un avertissement plus tot, ou
  // pour n > 8, est un vrai bug.
  const TRIALS = 300;

  for (let trial = 1; trial <= TRIALS; trial++) {
    test(`tournoi genere #${trial}`, () => {
      const rng = mulberry32(1000 + trial);
      const n = 4 + Math.floor(rng() * 13); // 4..16
      const players = makePlayers(n);
      const state = { players, rounds: [] };

      const roundsToPlay = Math.min(maxRounds(n), 7);

      const seenPairs = new Set();
      const byeReceived = new Set();
      const colorCount = new Map(players.map((p) => [p.id, { W: 0, B: 0 }]));

      for (let r = 0; r < roundsToPlay; r++) {
        const { pairings, warnings } = playRandomRound(state, rng);

        if (warnings.length > 0) {
          assert.ok(
            r === roundsToPlay - 1,
            `avertissement inattendu avant la derniere ronde (ronde ${r + 1}/${roundsToPlay}, n=${n})`
          );
          assert.ok(n <= 8, `avertissement inattendu pour un effectif n=${n} > 8 a la ronde ${r + 1}`);
        }

        // Invariant 1 : chaque joueur actif apparait exactement une fois.
        const activeIds = state.players.filter((p) => !p.withdrawn).map((p) => p.id);
        const appearances = new Map(activeIds.map((id) => [id, 0]));
        for (const pairing of pairings) {
          appearances.set(pairing.white, (appearances.get(pairing.white) ?? 0) + 1);
          if (pairing.black !== null) {
            appearances.set(pairing.black, (appearances.get(pairing.black) ?? 0) + 1);
          }
        }
        for (const id of activeIds) {
          assert.equal(appearances.get(id), 1, `joueur ${id} n'apparait pas exactement une fois a la ronde ${r + 1}`);
        }

        const byePairings = pairings.filter((p) => p.black === null);

        // Invariant 4 : bye seulement si effectif actif impair.
        if (activeIds.length % 2 === 1) {
          assert.equal(byePairings.length, 1, `bye attendu a la ronde ${r + 1} (effectif impair)`);
        } else {
          assert.equal(byePairings.length, 0, `bye inattendu a la ronde ${r + 1} (effectif pair)`);
        }

        // Invariant 3 : un seul bye par joueur sur tout le tournoi.
        for (const bye of byePairings) {
          assert.ok(!byeReceived.has(bye.white), `${bye.white} recoit un second bye`);
          byeReceived.add(bye.white);
        }

        // Invariant 2 (degradable, uniquement a la derniere ronde pour n <= 8) :
        // une revanche n'est acceptable que si pairRound l'a signalee dans
        // warnings, et le nombre d'avertissements doit correspondre
        // exactement au nombre de revanches.
        let rematchCount = 0;
        for (const pairing of pairings) {
          if (pairing.black === null) continue;
          const key = [pairing.white, pairing.black].sort().join("-");
          if (seenPairs.has(key)) {
            rematchCount += 1;
            assert.ok(
              warnings.some((w) => w.includes(pairing.white) && w.includes(pairing.black)),
              `revanche ${key} a la ronde ${r + 1} non signalee dans warnings`
            );
          }
          seenPairs.add(key);
          colorCount.get(pairing.white).W += 1;
          colorCount.get(pairing.black).B += 1;
        }
        assert.equal(warnings.length, rematchCount, `warnings ne correspond pas exactement aux revanches a la ronde ${r + 1}`);

        // Invariant 6 : total des points distribues = parties + byes.
        const gamesCount = pairings.filter((p) => p.black !== null).length;
        const byesCount = byePairings.length;
        const totalPoints = pairings.reduce((sum, p) => sum + pointsForPairing(p), 0);
        assert.equal(totalPoints, gamesCount + byesCount, `points distribues incoherents a la ronde ${r + 1}`);

        // Invariant 5 : ecart de couleurs par joueur.
        for (const id of activeIds) {
          const { W, B } = colorCount.get(id);
          assert.ok(Math.abs(W - B) <= 2, `${id} a un ecart de couleurs > 2 a la ronde ${r + 1} (W=${W}, B=${B})`);
        }
      }
    });
  }
});

describe("proprietes de l'appariement - campagne degradee (ancien plafond absolu)", () => {
  // On pousse volontairement jusqu'a l'ancien plafond (quasi round-robin),
  // la ou un appariement parfait peut ne plus exister. Les invariants 1, 3,
  // 4 et 6 doivent tenir sans exception. Seul l'invariant 2 (pas de
  // revanche) peut ceder, et uniquement si pairRound le declare dans
  // warnings. L'invariant 5 (couleurs) n'est jamais sacrifie par
  // construction : on verifie qu'il tient malgre tout.
  const TRIALS = 300;

  for (let trial = 1; trial <= TRIALS; trial++) {
    test(`tournoi genere (mode degrade) #${trial}`, () => {
      const rng = mulberry32(1000 + trial);
      const n = 4 + Math.floor(rng() * 13); // 4..16
      const players = makePlayers(n);
      const state = { players, rounds: [] };

      const roundsToPlay = Math.min(oldMaxRounds(n), 7);

      const seenPairs = new Set();
      const byeReceived = new Set();
      const colorCount = new Map(players.map((p) => [p.id, { W: 0, B: 0 }]));

      for (let r = 0; r < roundsToPlay; r++) {
        const { pairings, warnings } = playRandomRound(state, rng);

        // Invariant 1 : chaque joueur actif apparait exactement une fois.
        const activeIds = state.players.filter((p) => !p.withdrawn).map((p) => p.id);
        const appearances = new Map(activeIds.map((id) => [id, 0]));
        for (const pairing of pairings) {
          appearances.set(pairing.white, (appearances.get(pairing.white) ?? 0) + 1);
          if (pairing.black !== null) {
            appearances.set(pairing.black, (appearances.get(pairing.black) ?? 0) + 1);
          }
        }
        for (const id of activeIds) {
          assert.equal(appearances.get(id), 1, `joueur ${id} n'apparait pas exactement une fois a la ronde ${r + 1}`);
        }

        const byePairings = pairings.filter((p) => p.black === null);

        // Invariant 4 : bye seulement si effectif actif impair.
        if (activeIds.length % 2 === 1) {
          assert.equal(byePairings.length, 1, `bye attendu a la ronde ${r + 1} (effectif impair)`);
        } else {
          assert.equal(byePairings.length, 0, `bye inattendu a la ronde ${r + 1} (effectif pair)`);
        }

        // Invariant 3 : un seul bye par joueur sur tout le tournoi (jamais sacrifie).
        for (const bye of byePairings) {
          assert.ok(!byeReceived.has(bye.white), `${bye.white} recoit un second bye`);
          byeReceived.add(bye.white);
        }

        // Invariant 2 (degradable) : une revanche n'est acceptable que si
        // pairRound l'a explicitement signalee dans warnings, et le nombre
        // d'avertissements doit correspondre exactement au nombre de revanches.
        let rematchCount = 0;
        for (const pairing of pairings) {
          if (pairing.black === null) continue;
          const key = [pairing.white, pairing.black].sort().join("-");
          if (seenPairs.has(key)) {
            rematchCount += 1;
            assert.ok(
              warnings.some((w) => w.includes(pairing.white) && w.includes(pairing.black)),
              `revanche ${key} a la ronde ${r + 1} non signalee dans warnings`
            );
          }
          seenPairs.add(key);
          colorCount.get(pairing.white).W += 1;
          colorCount.get(pairing.black).B += 1;
        }
        assert.equal(warnings.length, rematchCount, `warnings ne correspond pas exactement aux revanches a la ronde ${r + 1}`);

        // Invariant 6 : total des points distribues = parties + byes.
        const gamesCount = pairings.filter((p) => p.black !== null).length;
        const byesCount = byePairings.length;
        const totalPoints = pairings.reduce((sum, p) => sum + pointsForPairing(p), 0);
        assert.equal(totalPoints, gamesCount + byesCount, `points distribues incoherents a la ronde ${r + 1}`);

        // Invariant 5 : jamais sacrifie, meme en mode degrade.
        for (const id of activeIds) {
          const { W, B } = colorCount.get(id);
          assert.ok(Math.abs(W - B) <= 2, `${id} a un ecart de couleurs > 2 a la ronde ${r + 1} (W=${W}, B=${B})`);
        }
      }
    });
  }
});

describe("non-regression : graines qui echouaient avant le mode degrade", () => {
  // Ces graines precises provoquaient "Aucun appariement valide trouve" avec
  // l'ancien moteur (qui levait une erreur des qu'un appariement parfait
  // etait impossible). Elles doivent maintenant aller au bout du tournoi,
  // quitte a signaler des revanches forcees dans warnings.
  const REGRESSION_TRIALS = [15, 86, 129, 168, 200, 205, 207, 214];

  for (const trial of REGRESSION_TRIALS) {
    test(`graine #${trial} va au bout du tournoi (mode degrade si necessaire)`, () => {
      const rng = mulberry32(1000 + trial);
      const n = 4 + Math.floor(rng() * 13);
      const state = { players: makePlayers(n), rounds: [] };
      const roundsToPlay = Math.min(oldMaxRounds(n), 7);

      assert.doesNotThrow(() => {
        for (let r = 0; r < roundsToPlay; r++) {
          playRandomRound(state, rng);
        }
      });
      assert.equal(state.rounds.length, roundsToPlay);
    });
  }
});

describe("non-regression : graines a revanche forcee sous le plafond suisse", () => {
  // Sous le plafond actuel (maxRounds), ces graines produisent encore une
  // revanche forcee, mais uniquement a la toute derniere ronde et pour un
  // petit effectif (n <= 8) : la degradation connue et acceptee. Ce test fige
  // ce comportement : la revanche doit rester signalee dans warnings, ne
  // jamais apparaitre avant la derniere ronde, et le tournoi va au bout.
  const WARNING_TRIALS = [15, 86, 129, 168, 200, 207, 214];

  for (const trial of WARNING_TRIALS) {
    test(`graine #${trial} : revanche forcee seulement a la derniere ronde, signalee`, () => {
      const rng = mulberry32(1000 + trial);
      const n = 4 + Math.floor(rng() * 13);
      assert.ok(n <= 8, `graine ${trial} : effectif n=${n} attendu <= 8`);
      const state = { players: makePlayers(n), rounds: [] };
      const roundsToPlay = Math.min(maxRounds(n), 7);

      for (let r = 0; r < roundsToPlay; r++) {
        const { warnings } = playRandomRound(state, rng);
        if (r < roundsToPlay - 1) {
          assert.deepEqual(warnings, [], `avertissement avant la derniere ronde (ronde ${r + 1})`);
        } else {
          assert.ok(warnings.length > 0, "la revanche forcee attendue a la derniere ronde n'est plus signalee");
          for (const w of warnings) {
            assert.match(w, /^Revanche forcee : /);
          }
        }
      }
      assert.equal(state.rounds.length, roundsToPlay);
    });
  }
});
