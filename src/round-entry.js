// Result-entry rules for a running tournament. PURE LOGIC — no DOM, no
// Supabase. Same standard as the engines.
//
// Reminder (CLAUDE.md): interface comfort only. RLS decides who may write,
// and a trigger decides when a result may be emptied.

import { isRoundComplete } from "./swiss.js";
import { isRoundRobin } from "./tournament-validation.js";
import { GAME_RESULTS } from "./tournament-edit.js";

export { GAME_RESULTS };

/** Entry buttons offered for a real game, in board order. */
export const ENTRY_CHOICES = [
  { value: "1-0", label: "1-0" },
  { value: "1/2-1/2", label: "½-½" },
  { value: "0-1", label: "0-1" },
];

/**
 * How far a round has been entered.
 * Byes count as entered: they carry their result from the moment the round
 * is created, and nobody has to type them.
 */
export function roundProgress(round) {
  const pairings = round?.pairings ?? [];
  const entered = pairings.filter(
    (p) => p.result !== null && p.result !== undefined
  ).length;
  return { entered, total: pairings.length, complete: isRoundComplete(round ?? { pairings: [] }) };
}

/** French summary of that progress, e.g. "4 / 5 résultats saisis". */
export function progressLabel(round) {
  const { entered, total } = roundProgress(round);
  return `${entered} / ${total} résultats saisis`;
}

/**
 * Whether results may be entered on this round at all.
 * Entry belongs to a running tournament: a draft has not started, and an
 * archive is closed.
 */
export function canEnterResults(tournament) {
  if (!tournament) return { ok: false, reason: "Tournoi introuvable." };
  if (tournament.status === "draft") {
    return { ok: false, reason: "Le tournoi n'a pas encore démarré." };
  }
  if (tournament.status === "archived") {
    return { ok: false, reason: "Le tournoi est clôturé : les résultats ne changent plus." };
  }
  if (tournament.status !== "ongoing") {
    return { ok: false, reason: "La saisie est réservée aux tournois en cours." };
  }
  return { ok: true, reason: null };
}

/** A bye is not a game: it is shown, never entered. */
export function isEditablePairing(pairing) {
  return Boolean(pairing) && pairing.black !== null && pairing.result !== "bye";
}

/**
 * What clicking `choice` should do on this pairing.
 * Clicking the button that is already active empties the result — that is
 * the cancel gesture, and it is the only way back to an empty cell.
 * @returns {"set"|"clear"|null} null when the pairing is not editable.
 */
export function resultClickAction(pairing, choice) {
  if (!isEditablePairing(pairing)) return null;
  if (!GAME_RESULTS.includes(choice)) return null;
  return pairing.result === choice ? "clear" : "set";
}

/**
 * What the organizer may do once the current round is finished.
 *
 *   "generate" — draw the next round. Swiss only: a round-robin has had its
 *                whole schedule written since creation, so its next round
 *                already exists and there is nothing to draw.
 *   "archive"  — every planned round has been played; close the tournament.
 *   null       — nothing yet, either mid-round or with rounds still ahead
 *                that are already on the calendar.
 *
 * @param {object} tournament row, with rounds_planned and format
 * @param {Array} rounds rounds recorded so far, in order
 */
export function nextRoundAction(tournament, rounds) {
  if (!tournament || tournament.status !== "ongoing") return null;

  const played = rounds ?? [];
  const last = played[played.length - 1];
  // Nothing to do until the round in progress is finished.
  if (played.length > 0 && !isRoundComplete(last)) return null;

  const planned = tournament.rounds_planned ?? 0;
  if (played.length >= planned) return "archive";

  // The circle method wrote every round up front: the next one is already
  // there, waiting to be played rather than drawn.
  if (isRoundRobin(tournament.format)) return null;

  return "generate";
}

/** Human wording for that action. */
export function nextRoundLabel(action) {
  if (action === "generate") return "Générer la ronde suivante";
  if (action === "archive") return "Clôturer le tournoi";
  return null;
}

/**
 * Confirmation shown before accepting a degraded draw. A forced rematch is
 * a real departure from the rules of the pairing, so the arbiter is told
 * exactly which boards are affected and has to say yes.
 */
export function warningsConfirmation(warnings) {
  return (
    "L'appariement de cette ronde n'a pas pu éviter toutes les revanches :\n\n" +
    warnings.map((w) => `• ${w}`).join("\n") +
    "\n\nEnregistrer cette ronde malgré tout ?"
  );
}

/**
 * Builds the tournament state the engines expect from the rounds recorded
 * so far.
 *
 * `withdrawn` is passed through under that exact name: src/swiss.js filters
 * its field on it, so renaming it here would silently draw players who have
 * left the tournament.
 */
export function engineState(players, rounds) {
  return {
    players: (players ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      withdrawn: p.withdrawn === true,
    })),
    rounds: (rounds ?? []).map((round) => ({
      pairings: round.pairings.map((p) => ({
        white: p.white,
        black: p.black,
        result: p.result,
      })),
    })),
  };
}
