// Round-robin pairing engine (circle method). PURE LOGIC — no DOM, no
// fetch, no Supabase, no Date.now(), no Math.random(). Same standard as
// src/swiss.js: inputs in, outputs out.
//
// Unlike the Swiss engine, this one can never reach a dead end: the circle
// method builds the whole schedule up front from the player count alone,
// independently of results. There is therefore no degraded mode and no
// `warnings` here — an impossible pairing simply cannot arise.
//
// A bye is represented like everywhere else in the project:
//   { white: id, black: null, result: 'bye' }

/** Sentinel occupying the odd seat; never leaves this module. */
const BYE = Symbol("bye");

function normalizeIds(players) {
  if (!Array.isArray(players)) {
    throw new TypeError("generateSchedule attend un tableau de joueurs");
  }
  const ids = players.map((player) =>
    player !== null && typeof player === "object" ? player.id : player
  );
  if (ids.some((id) => id === undefined || id === null || id === "")) {
    throw new Error("Chaque joueur doit avoir un identifiant");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("Les identifiants des joueurs doivent etre uniques");
  }
  if (ids.length < 2) {
    throw new Error("Un tournoi toutes rondes demande au moins deux joueurs");
  }
  return ids;
}

/**
 * Number of rounds a round-robin schedule will hold for `n` players:
 * n - 1 when n is even, n when n is odd (the fictitious bye player makes
 * the field even), doubled for a return leg.
 */
export function scheduleLength(n, { doubled = false } = {}) {
  if (!Number.isInteger(n) || n < 2) return 0;
  const seats = n % 2 === 0 ? n : n + 1;
  return (seats - 1) * (doubled ? 2 : 1);
}

function pairingFor(a, b, whiteFirst) {
  if (a === BYE) return { white: b, black: null, result: "bye" };
  if (b === BYE) return { white: a, black: null, result: "bye" };
  return whiteFirst
    ? { white: a, black: b, result: null }
    : { white: b, black: a, result: null };
}

function mirror(pairing) {
  if (pairing.black === null) return { ...pairing };
  return { white: pairing.black, black: pairing.white, result: null };
}

/**
 * Builds a complete round-robin schedule with the circle method: one seat
 * stays fixed while the others rotate one step per round, so every player
 * meets every other exactly once.
 *
 * @param {Array<string|{id: string}>} players
 * @param {{doubled?: boolean}} [options] doubled adds a mirrored return
 *   leg where every game is replayed with the colors swapped.
 * @returns {Array<Array<{white: string, black: string|null, result: string|null}>>}
 *   one entry per round, each holding that round's pairings.
 */
export function generateSchedule(players, { doubled = false } = {}) {
  const ids = normalizeIds(players);

  // Odd fields get a fictitious player: whoever faces it sits the round out.
  const seats = ids.length % 2 === 0 ? [...ids] : [...ids, BYE];
  const size = seats.length;
  const half = size / 2;
  const roundsPerLeg = size - 1;

  const firstLeg = [];
  for (let round = 0; round < roundsPerLeg; round++) {
    const pairings = [];
    for (let board = 0; board < half; board++) {
      const a = seats[board];
      const b = seats[size - 1 - board];
      // The top seat takes white, except on board 0: that seat never
      // rotates, so without alternating it there its player would collect
      // every white. Alternating it keeps every |white - black| <= 1.
      pairings.push(pairingFor(a, b, board === 0 ? round % 2 === 0 : true));
    }
    firstLeg.push(pairings);

    // Rotate every seat but the first, one step clockwise.
    seats.splice(1, 0, seats.pop());
  }

  if (!doubled) return firstLeg;
  return [...firstLeg, ...firstLeg.map((round) => round.map(mirror))];
}
