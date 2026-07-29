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
 * Whether the planned round count may still be changed.
 *
 * Two separate reasons to refuse, each reported on its own:
 *   - the tournament has left the draft stage: rounds are already paired
 *     and played, so moving the target would contradict what happened;
 *   - the format is a round-robin: its length is derived from the field and
 *     the whole schedule is already written, so the number is not a choice.
 */
export function canEditRoundsPlanned(tournament) {
  if (!tournament) return { ok: false, reason: "Tournoi introuvable." };
  if (isRoundRobin(tournament.format)) {
    return {
      ok: false,
      reason:
        "Ce format joue toutes les rencontres : son nombre de rondes découle " +
        "de l'effectif et ne se modifie pas.",
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
 */
export function validateRoundsPlannedEdit(tournament, roundsPlanned, playerCount) {
  const editable = canEditRoundsPlanned(tournament);
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
