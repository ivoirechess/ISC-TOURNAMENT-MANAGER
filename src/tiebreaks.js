// Tie-break systems. PURE LOGIC — no DOM, no fetch, no Supabase, no
// Date.now(), no Math.random(). Same standard as src/swiss.js.
//
// Input is the usual tournament state:
//   {
//     players: [{ id, name }],
//     rounds: [{ pairings: [{ white, black, result }] }],
//   }
// with result in '1-0' | '0-1' | '1/2-1/2' | 'bye' | null.
//
// Definitions follow the FIDE tie-break regulations. Where this project
// deliberately stays simpler than FIDE, it is called out in a comment.

// Kept in step with the CHECK constraint on tournaments.tiebreaks
// (supabase/migrations/20260729120000_tournament_tiebreaks.sql): adding a
// key here without adding it there gets the row rejected server-side. A
// test reads the migration to keep the two from drifting apart.
/** Tie-breaks an organizer may pick, in the order they are offered. */
export const TIEBREAK_KEYS = [
  "buchholz",
  "buchholzCut1",
  "sonnebornBerger",
  "cumulative",
  "wins",
  "directEncounter",
];

/** French labels for the interface. */
export const TIEBREAK_LABELS = {
  buchholz: "Buchholz",
  buchholzCut1: "Buchholz tronqué-1",
  sonnebornBerger: "Sonneborn-Berger",
  cumulative: "Cumulatif",
  wins: "Victoires",
  directEncounter: "Confrontation directe",
  alphabetical: "Ordre alphabétique",
};

const POINTS = {
  win: 1,
  draw: 0.5,
  loss: 0,
  bye: 1, // CLAUDE.md: a bye is worth 1 point
};

function pointsFor(pairing, playerId) {
  if (pairing.white === playerId) {
    if (pairing.result === "bye") return POINTS.bye;
    if (pairing.result === "1-0") return POINTS.win;
    if (pairing.result === "1/2-1/2") return POINTS.draw;
    return POINTS.loss;
  }
  if (pairing.black === playerId) {
    if (pairing.result === "0-1") return POINTS.win;
    if (pairing.result === "1/2-1/2") return POINTS.draw;
    return POINTS.loss;
  }
  return 0;
}

function hasResult(pairing) {
  return pairing.result !== null && pairing.result !== undefined;
}

// A round counts as played once at least one real game in it has a result.
// Rounds sitting there unplayed must not count: a round-robin writes its
// whole schedule at creation, so state.rounds.length is not a round count.
// Byes alone do not make a round played either — they are written with the
// schedule, and counting them early would hand out points for rounds nobody
// has played yet.
function isPlayedRound(round) {
  return (round.pairings ?? []).some((p) => p.black !== null && hasResult(p));
}

function playedRoundCount(rounds) {
  return rounds.filter(isPlayedRound).length;
}

/**
 * Walks the state once and indexes everything the tie-breaks need.
 * Internal: the exported functions below each rebuild it, so they stay
 * independent; computeStandings builds it a single time.
 */
function buildIndex(state) {
  const rounds = state.rounds ?? [];
  const totalPlayedRounds = playedRoundCount(rounds);

  const index = new Map(
    (state.players ?? []).map((player) => [
      player.id,
      {
        id: player.id,
        name: player.name ?? String(player.id),
        points: 0,
        wins: 0,
        perRound: [], // points gained, round by round
        cumulative: 0,
        opponents: [], // real games: { opponentId, scored }
        unplayed: [], // byes: { roundNumber, scored }
      },
    ])
  );

  // Only played rounds advance the standings, and they are numbered by
  // their rank among played rounds — perRound and the virtual-opponent
  // formula both index on that sequence, not on the stored round number.
  let playedSoFar = 0;
  for (const round of rounds) {
    if (!isPlayedRound(round)) continue;
    playedSoFar += 1;
    const gained = new Map();

    for (const pairing of round.pairings) {
      if (!hasResult(pairing)) continue;

      if (pairing.black === null) {
        const record = index.get(pairing.white);
        if (record) {
          const scored = pointsFor(pairing, pairing.white);
          gained.set(pairing.white, scored);
          record.unplayed.push({ roundNumber: playedSoFar, scored });
        }
        continue;
      }

      for (const [playerId, opponentId] of [
        [pairing.white, pairing.black],
        [pairing.black, pairing.white],
      ]) {
        const record = index.get(playerId);
        if (!record) continue;
        const scored = pointsFor(pairing, playerId);
        gained.set(playerId, scored);
        record.opponents.push({ opponentId, scored });
        if (scored === POINTS.win) record.wins += 1;
      }
    }

    // Running totals: every player advances a round, even without a game.
    for (const record of index.values()) {
      const scored = gained.get(record.id) ?? 0;
      record.points += scored;
      record.perRound.push(scored);
      record.cumulative += record.points;
    }
  }

  return { players: index, totalPlayedRounds };
}

// Score of the virtual opponent standing in for an unplayed game, per the
// FIDE rule: it holds the player's score from before that round, takes the
// complement of the unplayed result, then draws every remaining round.
//
//   Svon = SPR + (1 - SfPR) + 0.5 * (n - R)
//
// with SPR the player's score before round R, SfPR what the player scored
// for the unplayed game, and n the number of played rounds. A bye here is
// worth 1 point, so (1 - SfPR) is 0 and the virtual opponent simply keeps
// the player's score of the moment plus half a point per remaining round.
function virtualOpponentScore(record, unplayed, totalPlayedRounds) {
  const scoreBefore = record.perRound
    .slice(0, unplayed.roundNumber - 1)
    .reduce((sum, value) => sum + value, 0);
  const remaining = Math.max(0, totalPlayedRounds - unplayed.roundNumber);
  return scoreBefore + (1 - unplayed.scored) + 0.5 * remaining;
}

// Scores of every opponent faced, virtual opponents included, which is what
// both Buchholz and its truncated form work from.
function opponentScores(index, playerId) {
  const record = index.players.get(playerId);
  if (!record) return [];

  const real = record.opponents.map(
    ({ opponentId }) => index.players.get(opponentId)?.points ?? 0
  );
  const virtual = record.unplayed.map((unplayed) =>
    virtualOpponentScore(record, unplayed, index.totalPlayedRounds)
  );
  return [...real, ...virtual];
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

// --- Individual tie-breaks ------------------------------------------------
// Each one is self-contained: give it a state and a player, get a number.

/** Sum of the scores of every opponent faced. */
export function buchholz(state, playerId) {
  return buchholzFrom(buildIndex(state), playerId);
}

function buchholzFrom(index, playerId) {
  return sum(opponentScores(index, playerId));
}

/** Buchholz minus the weakest opponent's score. */
export function buchholzCut1(state, playerId) {
  return buchholzCut1From(buildIndex(state), playerId);
}

function buchholzCut1From(index, playerId) {
  const scores = opponentScores(index, playerId);
  if (scores.length === 0) return 0;
  return sum(scores) - Math.min(...scores);
}

/**
 * Sonneborn-Berger: each opponent's score weighted by what was scored
 * against them — a win brings their full score, a draw half of it.
 */
export function sonnebornBerger(state, playerId) {
  return sonnebornBergerFrom(buildIndex(state), playerId);
}

function sonnebornBergerFrom(index, playerId) {
  const record = index.players.get(playerId);
  if (!record) return 0;

  const real = record.opponents.map(
    ({ opponentId, scored }) => (index.players.get(opponentId)?.points ?? 0) * scored
  );
  const virtual = record.unplayed.map(
    (unplayed) =>
      virtualOpponentScore(record, unplayed, index.totalPlayedRounds) * unplayed.scored
  );
  return sum([...real, ...virtual]);
}

/** Sum of the running score after each round (progressive score). */
export function cumulative(state, playerId) {
  return cumulativeFrom(buildIndex(state), playerId);
}

function cumulativeFrom(index, playerId) {
  return index.players.get(playerId)?.cumulative ?? 0;
}

/** Number of games won (a bye is not a win). */
export function wins(state, playerId) {
  return winsFrom(buildIndex(state), playerId);
}

function winsFrom(index, playerId) {
  return index.players.get(playerId)?.wins ?? 0;
}

/**
 * Direct encounter — the results the tied players scored against each other.
 *
 * It only applies when EVERY pair inside the tied group has met at least
 * once. Otherwise the comparison would rest on games that never happened,
 * so the tie-break is skipped and the next one in the chosen order takes
 * over.
 *
 * Example with three players tied on points:
 *   - A-B played, A-C played, B-C never played
 *     → one pair missing, so direct encounter is ignored for this group
 *       and the next tie-break decides.
 *   - A-B, A-C and B-C all played
 *     → applies: each player scores the sum of what they took from the two
 *       others.
 *
 * A pair that met several times (possible in a double round-robin) counts
 * for the AVERAGE of those games, never their raw sum: two players who met
 * twice must not weigh more than two who met once.
 *
 * @returns {Map<string, number>|null} value per player, or null when the
 *   group is not eligible.
 */
export function directEncounter(state, tiedPlayerIds) {
  return directEncounterFrom(buildIndex(state), tiedPlayerIds);
}

function directEncounterFrom(index, tiedPlayerIds) {
  const group = [...tiedPlayerIds];
  if (group.length < 2) return null;

  // Games played inside the group, collected per pair.
  const perPair = new Map(); // "a|b" (sorted) -> [scores of a]
  const groupSet = new Set(group);

  for (const playerId of group) {
    const record = index.players.get(playerId);
    if (!record) return null;
    for (const { opponentId, scored } of record.opponents) {
      if (!groupSet.has(opponentId)) continue;
      const key = [playerId, opponentId].sort().join("|");
      const entry = perPair.get(key) ?? { scores: new Map() };
      const existing = entry.scores.get(playerId) ?? [];
      existing.push(scored);
      entry.scores.set(playerId, existing);
      perPair.set(key, entry);
    }
  }

  // Every pair must have met, otherwise the tie-break does not apply.
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const key = [group[i], group[j]].sort().join("|");
      if (!perPair.has(key)) return null;
    }
  }

  const values = new Map(group.map((id) => [id, 0]));
  for (const entry of perPair.values()) {
    for (const [playerId, scores] of entry.scores) {
      values.set(playerId, values.get(playerId) + sum(scores) / scores.length);
    }
  }
  return values;
}

/**
 * Alphabetical order — never selectable, always appended as the very last
 * net so the standings stay deterministic even when every chosen tie-break
 * leaves players level. Ties are settled on the name, then on the id in the
 * unlikely case of two identical names.
 */
export function alphabetical(state, playerIdA, playerIdB) {
  const index = buildIndex(state);
  return alphabeticalFrom(index, playerIdA, playerIdB);
}

function alphabeticalFrom(index, playerIdA, playerIdB) {
  const a = index.players.get(playerIdA);
  const b = index.players.get(playerIdB);
  const nameA = a?.name ?? String(playerIdA);
  const nameB = b?.name ?? String(playerIdB);
  const byName = nameA.localeCompare(nameB, "fr");
  if (byName !== 0) return byName;
  return String(playerIdA).localeCompare(String(playerIdB));
}

// --- Standings ------------------------------------------------------------

const SCALAR_TIEBREAKS = {
  buchholz: buchholzFrom,
  buchholzCut1: buchholzCut1From,
  sonnebornBerger: sonnebornBergerFrom,
  cumulative: cumulativeFrom,
  wins: winsFrom,
};

/**
 * Checks the tie-break selection an organizer made.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTiebreakSelection(selected) {
  const errors = [];
  if (!Array.isArray(selected)) {
    return { ok: false, errors: ["La liste des departages est invalide."] };
  }
  if (selected.length < 2) {
    errors.push("Choisissez au moins deux departages.");
  }
  if (selected.length > 6) {
    errors.push("Six departages au maximum.");
  }
  if (selected.some((key) => !TIEBREAK_KEYS.includes(key))) {
    errors.push("Un des departages choisis n'existe pas.");
  }
  if (new Set(selected).size !== selected.length) {
    errors.push("Un meme departage ne peut pas etre choisi deux fois.");
  }
  return { ok: errors.length === 0, errors };
}

// Splits a group along one tie-break, then keeps going down the list.
// Returning null for a criterion means "not applicable here" — the group
// moves on to the next criterion untouched, which is what makes direct
// encounter skippable per group.
function resolveGroup(index, group, criteria, criterionIndex) {
  if (group.length <= 1) return group;

  if (criterionIndex >= criteria.length) {
    // Last net: alphabetical order, always deterministic.
    return [...group].sort((a, b) => alphabeticalFrom(index, a, b));
  }

  const criterion = criteria[criterionIndex];
  let values;
  if (criterion === "directEncounter") {
    values = directEncounterFrom(index, group);
    if (values === null) {
      return resolveGroup(index, group, criteria, criterionIndex + 1);
    }
  } else {
    const compute = SCALAR_TIEBREAKS[criterion];
    values = new Map(group.map((id) => [id, compute(index, id)]));
  }

  const buckets = new Map();
  for (const playerId of group) {
    const value = values.get(playerId);
    if (!buckets.has(value)) buckets.set(value, []);
    buckets.get(value).push(playerId);
  }

  return [...buckets.keys()]
    .sort((a, b) => b - a)
    .flatMap((value) =>
      resolveGroup(index, buckets.get(value), criteria, criterionIndex + 1)
    );
}

/**
 * Full standings, sorted.
 *
 * Points always come first and are never part of `selectedTiebreaks`; the
 * chosen tie-breaks then apply in order, and alphabetical order closes the
 * list so two players are never left in an undefined order.
 *
 * @param {{players: Array, rounds: Array}} state
 * @param {string[]} selectedTiebreaks ordered, 2 to 6 keys from TIEBREAK_KEYS
 * @returns {Array<{playerId: string, name: string, points: number, rank: number}>}
 *   each row also carrying one field per chosen tie-break. A direct
 *   encounter that did not apply to a player's group reads null.
 */
export function computeStandings(state, selectedTiebreaks) {
  const check = validateTiebreakSelection(selectedTiebreaks);
  if (!check.ok) {
    throw new Error(check.errors.join(" "));
  }

  const index = buildIndex(state);
  const playerIds = (state.players ?? []).map((player) => player.id);

  // Points first, always.
  const byPoints = new Map();
  for (const playerId of playerIds) {
    const points = index.players.get(playerId).points;
    if (!byPoints.has(points)) byPoints.set(points, []);
    byPoints.get(points).push(playerId);
  }

  const ordered = [...byPoints.keys()]
    .sort((a, b) => b - a)
    .flatMap((points) => resolveGroup(index, byPoints.get(points), selectedTiebreaks, 0));

  // Direct encounter is group-dependent, so its displayed value is computed
  // over the players a row was actually tied with on points.
  const directValues = new Map();
  if (selectedTiebreaks.includes("directEncounter")) {
    for (const group of byPoints.values()) {
      const values = directEncounterFrom(index, group);
      if (values === null) continue;
      for (const [playerId, value] of values) directValues.set(playerId, value);
    }
  }

  return ordered.map((playerId, position) => {
    const record = index.players.get(playerId);
    const row = {
      playerId,
      name: record.name,
      points: record.points,
      rank: position + 1,
    };
    for (const criterion of selectedTiebreaks) {
      row[criterion] =
        criterion === "directEncounter"
          ? directValues.get(playerId) ?? null
          : SCALAR_TIEBREAKS[criterion](index, playerId);
    }
    return row;
  });
}
