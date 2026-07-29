// Rules for editing an existing tournament. PURE LOGIC — no DOM, no
// Supabase. Same standard as the other engines.
//
// Reminder (CLAUDE.md): these checks are interface comfort. Ownership is
// enforced by RLS, and the "draft only" rule below is also enforced by a
// trigger, so neither depends on the browser.

import { isRoundRobin } from "./tournament-validation.js";
import { validateRoundCount } from "./swiss.js";

/** Results an organizer may enter for a real game. */
export const GAME_RESULTS = ["1-0", "0-1", "1/2-1/2"];

/** French labels for the interface. */
export const RESULT_LABELS = {
  "1-0": "1-0 (blancs)",
  "0-1": "0-1 (noirs)",
  "1/2-1/2": "½-½ (nulle)",
  bye: "Exempt",
};

/** A name can be corrected at any point in the tournament's life. */
export function validateTournamentName(name) {
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, errors: ["Le nom du tournoi est obligatoire."] };
  }
  return { ok: true, errors: [] };
}

/**
 * Whether the planned round count may still be changed. The checks run in
 * the same order as the database trigger, so the reason shown on screen is
 * the reason the server would give.
 *
 * Three separate grounds for refusing:
 *   - the format is a round-robin: its length is derived from the field and
 *     the whole schedule is already written, so the number is not a choice;
 *   - the tournament already has rounds: the target they were built against
 *     cannot move under them. This is the substantive test — `status` alone
 *     would not do, since it can be set back to 'draft';
 *   - failing that, the tournament has simply left the draft stage.
 */
export function canEditRoundsPlanned(tournament, roundCount = 0) {
  if (!tournament) return { ok: false, reason: "Tournoi introuvable." };
  if (isRoundRobin(tournament.format)) {
    return {
      ok: false,
      reason:
        "Ce format joue toutes les rencontres : son nombre de rondes découle " +
        "de l'effectif et ne se modifie pas.",
    };
  }
  if (roundCount > 0) {
    return {
      ok: false,
      reason:
        "Le tournoi a déjà des rondes : le nombre de rondes prévues ne peut " +
        "plus changer, il ne concorderait plus avec ce qui a été joué.",
    };
  }
  if (tournament.status !== "draft") {
    return {
      ok: false,
      reason:
        "Le tournoi est lancé : le nombre de rondes ne peut plus changer. " +
        "Il ne concorderait plus avec les rondes déjà jouées.",
    };
  }
  return { ok: true, reason: null };
}

/**
 * Validates a new planned round count against the same guard used at
 * creation, so an edit cannot slip past what creation would have refused.
 * @param {object} tournament the row being edited
 * @param {number} roundsPlanned the requested value
 * @param {number} playerCount registered players
 * @param {number} roundCount rounds already recorded for this tournament
 */
export function validateRoundsPlannedEdit(tournament, roundsPlanned, playerCount, roundCount = 0) {
  const editable = canEditRoundsPlanned(tournament, roundCount);
  if (!editable.ok) return { ok: false, errors: [editable.reason] };

  if (!Number.isInteger(roundsPlanned) || roundsPlanned < 1) {
    return { ok: false, errors: ["Le nombre de rondes doit etre un entier superieur ou egal a 1."] };
  }

  const check = validateRoundCount(playerCount, roundsPlanned);
  if (check.blocked) {
    return {
      ok: false,
      errors: [`${check.message} Maximum pour ${playerCount} joueurs : ${check.max} ronde(s).`],
    };
  }
  return { ok: true, errors: [], warning: check.warning ? check.recommended : null };
}

/**
 * Validates a correction to an already-entered result.
 *
 * Pairings never move: only the result changes. A bye is not editable — it
 * is not a game, and the schema ties `black_player_id is null` to
 * `result = 'bye'`, so turning one into a game result would be rejected
 * server-side anyway.
 */
export function validateResultEdit(pairing, newResult) {
  if (!pairing) {
    return { ok: false, errors: ["Appariement introuvable."] };
  }
  if (pairing.black === null || pairing.result === "bye") {
    return { ok: false, errors: ["Un joueur exempt n'a pas de résultat à corriger."] };
  }
  if (!GAME_RESULTS.includes(newResult)) {
    return { ok: false, errors: ["Résultat invalide."] };
  }
  if (pairing.result === null || pairing.result === undefined) {
    return { ok: false, errors: ["Cette partie n'a pas encore de résultat à corriger."] };
  }
  if (pairing.result === newResult) {
    return { ok: false, errors: ["Ce résultat est déjà celui enregistré."] };
  }
  return { ok: true, errors: [] };
}
