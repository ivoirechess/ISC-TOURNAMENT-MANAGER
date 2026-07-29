import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateSchedule, scheduleLength } from "../src/roundrobin.js";
import { pairRound, maxRounds } from "../src/swiss.js";

function makeIds(n) {
  return Array.from({ length: n }, (_, i) => `p${i + 1}`);
}

// Seeded PRNG (mulberry32), test-only: the engines never use Math.random().
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

function pairKey(a, b) {
  return [a, b].sort().join("-");
}

// Player counts covered by the property campaign.
const SIZES = Array.from({ length: 13 }, (_, i) => i + 4); // 4..16

describe("scheduleLength", () => {
  test("n-1 rondes pour un effectif pair, n pour un effectif impair", () => {
    assert.equal(scheduleLength(4), 3);
    assert.equal(scheduleLength(10), 9);
    assert.equal(scheduleLength(5), 5);
    assert.equal(scheduleLength(9), 9);
  });

  test("l'aller-retour double le nombre de rondes", () => {
    assert.equal(scheduleLength(4, { doubled: true }), 6);
    assert.equal(scheduleLength(5, { doubled: true }), 10);
  });

  test("0 pour un effectif insuffisant", () => {
    assert.equal(scheduleLength(1), 0);
    assert.equal(scheduleLength(0), 0);
  });

  test("annonce exactement ce que generateSchedule produit", () => {
    for (const n of SIZES) {
      for (const doubled of [false, true]) {
        assert.equal(
          generateSchedule(makeIds(n), { doubled }).length,
          scheduleLength(n, { doubled }),
          `n=${n}, doubled=${doubled}`
        );
      }
    }
  });
});

describe("entrees invalides", () => {
  test("refuse moins de deux joueurs", () => {
    assert.throws(() => generateSchedule([]), /au moins deux joueurs/);
    assert.throws(() => generateSchedule(["p1"]), /au moins deux joueurs/);
  });

  test("refuse les identifiants dupliques ou manquants", () => {
    assert.throws(() => generateSchedule(["p1", "p1"]), /uniques/);
    assert.throws(() => generateSchedule(["p1", null]), /identifiant/);
    assert.throws(() => generateSchedule(["p1", { name: "sans id" }]), /identifiant/);
  });

  test("accepte aussi bien des identifiants que des objets joueur", () => {
    const fromIds = generateSchedule(["a", "b", "c", "d"]);
    const fromObjects = generateSchedule([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    assert.deepEqual(fromObjects, fromIds);
  });

  test("deterministe : deux appels identiques donnent le meme calendrier", () => {
    const ids = makeIds(9);
    assert.deepEqual(generateSchedule(ids), generateSchedule(ids));
  });
});

describe("proprietes du calendrier - tour simple", () => {
  for (const n of SIZES) {
    test(`${n} joueurs`, () => {
      const ids = makeIds(n);
      const schedule = generateSchedule(ids);

      // (3) nombre de rondes exact
      const expectedRounds = n % 2 === 0 ? n - 1 : n;
      assert.equal(schedule.length, expectedRounds);

      const meetings = new Map();
      const byeCount = new Map(ids.map((id) => [id, 0]));

      for (const [index, round] of schedule.entries()) {
        // (2) chaque joueur joue exactement une fois par ronde
        const appearances = new Map(ids.map((id) => [id, 0]));
        for (const pairing of round) {
          appearances.set(pairing.white, appearances.get(pairing.white) + 1);
          if (pairing.black !== null) {
            appearances.set(pairing.black, appearances.get(pairing.black) + 1);
          }
        }
        for (const id of ids) {
          assert.equal(appearances.get(id), 1, `${id} n'apparait pas une seule fois a la ronde ${index + 1}`);
        }

        // Bye si et seulement si l'effectif est impair, et un seul par ronde.
        const byes = round.filter((p) => p.black === null);
        assert.equal(byes.length, n % 2 === 1 ? 1 : 0, `byes incoherents a la ronde ${index + 1}`);
        for (const bye of byes) {
          assert.equal(bye.result, "bye");
          byeCount.set(bye.white, byeCount.get(bye.white) + 1);
        }

        for (const pairing of round) {
          if (pairing.black === null) continue;
          assert.equal(pairing.result, null);
          const key = pairKey(pairing.white, pairing.black);
          meetings.set(key, (meetings.get(key) ?? 0) + 1);
        }
      }

      // (1) chaque paire distincte se rencontre exactement une fois
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = pairKey(ids[i], ids[j]);
          assert.equal(meetings.get(key), 1, `${key} ne se rencontre pas exactement une fois`);
        }
      }
      assert.equal(meetings.size, (n * (n - 1)) / 2);

      // Effectif impair : chaque joueur est exempt exactement une fois.
      for (const id of ids) {
        assert.equal(byeCount.get(id), n % 2 === 1 ? 1 : 0, `byes de ${id}`);
      }
    });
  }
});

describe("proprietes du calendrier - aller-retour", () => {
  for (const n of SIZES) {
    test(`${n} joueurs`, () => {
      const ids = makeIds(n);
      const schedule = generateSchedule(ids, { doubled: true });

      // (3) nombre de rondes exact
      const expectedRounds = (n % 2 === 0 ? n - 1 : n) * 2;
      assert.equal(schedule.length, expectedRounds);

      const meetings = new Map();
      const byeCount = new Map(ids.map((id) => [id, 0]));

      for (const [index, round] of schedule.entries()) {
        // (2) chaque joueur joue exactement une fois par ronde
        const appearances = new Map(ids.map((id) => [id, 0]));
        for (const pairing of round) {
          appearances.set(pairing.white, appearances.get(pairing.white) + 1);
          if (pairing.black !== null) {
            appearances.set(pairing.black, appearances.get(pairing.black) + 1);
          }
        }
        for (const id of ids) {
          assert.equal(appearances.get(id), 1, `${id} n'apparait pas une seule fois a la ronde ${index + 1}`);
        }

        for (const pairing of round) {
          if (pairing.black === null) {
            byeCount.set(pairing.white, byeCount.get(pairing.white) + 1);
            continue;
          }
          const key = pairKey(pairing.white, pairing.black);
          const seen = meetings.get(key) ?? [];
          seen.push(`${pairing.white}>${pairing.black}`);
          meetings.set(key, seen);
        }
      }

      // (1) chaque paire distincte se rencontre exactement deux fois, une
      // fois dans chaque sens : les couleurs sont bien inversees au retour.
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = pairKey(ids[i], ids[j]);
          const seen = meetings.get(key);
          assert.equal(seen?.length, 2, `${key} ne se rencontre pas exactement deux fois`);
          assert.notEqual(seen[0], seen[1], `${key} joue deux fois avec les memes couleurs`);
        }
      }

      // Effectif impair : deux byes par joueur (un par tour).
      for (const id of ids) {
        assert.equal(byeCount.get(id), n % 2 === 1 ? 2 : 0, `byes de ${id}`);
      }
    });
  }

  test("le tour retour est le miroir exact du tour aller", () => {
    for (const n of SIZES) {
      const ids = makeIds(n);
      const single = generateSchedule(ids);
      const doubled = generateSchedule(ids, { doubled: true });
      assert.deepEqual(doubled.slice(0, single.length), single, `aller inchange pour n=${n}`);

      for (const [index, round] of single.entries()) {
        const returnRound = doubled[single.length + index];
        for (const [board, pairing] of round.entries()) {
          const mirrored = returnRound[board];
          if (pairing.black === null) {
            assert.deepEqual(mirrored, pairing);
          } else {
            assert.equal(mirrored.white, pairing.black);
            assert.equal(mirrored.black, pairing.white);
          }
        }
      }
    }
  });
});

describe("equilibre des couleurs", () => {
  for (const n of SIZES) {
    test(`${n} joueurs : |blancs - noirs| <= 1`, () => {
      const ids = makeIds(n);
      for (const doubled of [false, true]) {
        const counts = new Map(ids.map((id) => [id, { white: 0, black: 0 }]));
        for (const round of generateSchedule(ids, { doubled })) {
          for (const pairing of round) {
            if (pairing.black === null) continue;
            counts.get(pairing.white).white += 1;
            counts.get(pairing.black).black += 1;
          }
        }
        for (const id of ids) {
          const { white, black } = counts.get(id);
          assert.ok(
            Math.abs(white - black) <= 1,
            `${id} : ${white} blancs / ${black} noirs (doubled=${doubled})`
          );
        }
      }
    });
  }
});

describe("aucune impasse possible, contrairement au suisse", () => {
  // Le suisse construit ronde par ronde et peut, en fin de tournoi sur un
  // petit effectif, n'avoir plus aucun appariement inedit disponible : il
  // degrade alors en signalant des revanches dans `warnings`. La methode du
  // cercle construit tout le calendrier d'avance : la question ne se pose
  // jamais. Ces tests le constatent au lieu de l'affirmer.

  test("le calendrier va toujours au bout, sans exception ni ronde incomplete", () => {
    for (const n of SIZES) {
      for (const doubled of [false, true]) {
        const ids = makeIds(n);
        let schedule;
        assert.doesNotThrow(() => {
          schedule = generateSchedule(ids, { doubled });
        }, `n=${n}, doubled=${doubled}`);

        assert.equal(schedule.length, scheduleLength(n, { doubled }));
        const boardsPerRound = Math.ceil(n / 2);
        for (const [index, round] of schedule.entries()) {
          assert.equal(round.length, boardsPerRound, `ronde ${index + 1} incomplete (n=${n})`);
        }
      }
    }
  });

  test("aucune revanche forcee : le tour simple atteint le maximum theorique", () => {
    // Toutes les rencontres possibles sont couvertes, chacune une seule
    // fois. Il n'existe donc aucune ronde ou le moteur aurait du rejouer
    // une paire faute de mieux.
    for (const n of SIZES) {
      const ids = makeIds(n);
      const seen = new Set();
      for (const round of generateSchedule(ids)) {
        for (const pairing of round) {
          if (pairing.black === null) continue;
          const key = pairKey(pairing.white, pairing.black);
          assert.ok(!seen.has(key), `revanche ${key} pour n=${n}`);
          seen.add(key);
        }
      }
      assert.equal(seen.size, (n * (n - 1)) / 2, `couverture incomplete pour n=${n}`);
    }
  });

  test("le moteur ne connait pas la notion de warnings", () => {
    // Contraste explicite avec pairRound, qui retourne { pairings, warnings }.
    const schedule = generateSchedule(makeIds(8));
    assert.ok(Array.isArray(schedule));
    for (const round of schedule) {
      assert.ok(Array.isArray(round), "une ronde est une simple liste de paires");
    }
  });

  test("le suisse s'arrete avant le round-robin, le cercle le couvre entierement", () => {
    // Contraste structurel, verifiable sans dependre de la dynamique d'un
    // tournoi : le garde-fou du suisse plafonne volontairement sous le
    // round-robin complet, parce qu'il n'y tient pas. La methode du cercle
    // va jusqu'au bout par construction. C'est precisement le domaine que
    // ce nouveau format vient couvrir.
    for (const n of SIZES) {
      assert.ok(
        maxRounds(n) < scheduleLength(n),
        `pour n=${n}, le plafond suisse (${maxRounds(n)}) devrait rester sous ` +
        `le calendrier complet (${scheduleLength(n)})`
      );
    }
  });

  test("cas concret : le suisse degrade, le cercle couvre les memes rencontres sans revanche", () => {
    // Deroulement reel sur 5 joueurs, pousse jusqu'au round-robin complet.
    // La degradation du suisse depend de la dynamique des resultats, pas du
    // seul effectif : cette graine est un cas ou elle se produit vraiment
    // (verifie : 21 configurations sur 200 degradent ainsi). Elle sert de
    // temoin, pas de generalite.
    const n = 5;
    const ids = makeIds(n);
    const rng = mulberry32(5);
    const results = ["1-0", "0-1", "1/2-1/2"];
    const state = { players: ids.map((id) => ({ id, name: id })), rounds: [] };

    let swissWarned = false;
    for (let round = 0; round < scheduleLength(n); round++) {
      const { pairings, warnings } = pairRound(state);
      if (warnings.length > 0) swissWarned = true;
      for (const pairing of pairings) {
        if (pairing.black !== null) {
          pairing.result = results[Math.floor(rng() * results.length)];
        }
      }
      state.rounds.push({ pairings });
    }
    assert.equal(swissWarned, true, "cette graine devrait faire degrader le suisse");

    // Meme effectif, meme nombre de rondes, par la methode du cercle :
    // toutes les rencontres, aucune revanche, aucun avertissement a emettre.
    const seen = new Set();
    for (const schedRound of generateSchedule(ids)) {
      for (const pairing of schedRound) {
        if (pairing.black === null) continue;
        const key = pairKey(pairing.white, pairing.black);
        assert.ok(!seen.has(key), "la methode du cercle ne devrait jamais rejouer une paire");
        seen.add(key);
      }
    }
    assert.equal(seen.size, (n * (n - 1)) / 2);
  });
});
