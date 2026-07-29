// Tournament creation rules. PURE LOGIC — no DOM, no Supabase.
// Round-count guards delegate to the engines (src/swiss.js,
// src/roundrobin.js), which stay the single source of truth for them.
//
// Reminder (CLAUDE.md): these checks are interface comfort; RLS decides
// server-side who may actually create anything.

import { validateRoundCount } from "./swiss.js";
import { scheduleLength } from "./roundrobin.js";

// Knockout is still out: it needs a bracket model the schema does not
// describe yet. The other three are playable.
export const FORMATS = [
  { value: "swiss", label: "Suisse", enabled: true },
  { value: "round_robin", label: "Toutes rondes", enabled: true },
  { value: "knockout", label: "Coupe", enabled: false },
  { value: "double_round_robin", label: "Aller-retour", enabled: true },
];

export function isFormatAvailable(format) {
  return FORMATS.some((f) => f.value === format && f.enabled);
}

/** True for the two formats served by the circle method. */
export function isRoundRobin(format) {
  return format === "round_robin" || format === "double_round_robin";
}

/**
 * Round count imposed by the format, or null when the organizer chooses
 * freely. A round-robin plays every pairing, so its length follows from the
 * player count alone — there is nothing to pick.
 */
export function imposedRoundCount(format, playerCount) {
  if (!isRoundRobin(format)) return null;
  if (!Number.isInteger(playerCount) || playerCount < 2) return null;
  return scheduleLength(playerCount, { doubled: format === "double_round_robin" });
}

/**
 * Validates a tournament draft before creation.
 * @param {{name: string, format: string, roundsPlanned: number, playerCount: number}} draft
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 *   errors block creation; warnings never do.
 */
export function validateTournamentDraft({ name, format, roundsPlanned, playerCount }) {
  const errors = [];
  const warnings = [];

  if (typeof name !== "string" || name.trim() === "") {
    errors.push("Le nom du tournoi est obligatoire.");
  }
  if (!isFormatAvailable(format)) {
    errors.push("Ce format n'est pas encore disponible.");
  }
  if (!Number.isInteger(roundsPlanned) || roundsPlanned < 1) {
    errors.push("Le nombre de rondes doit etre un entier superieur ou egal a 1.");
  }
  if (!Number.isInteger(playerCount) || playerCount < 2) {
    errors.push("Selectionnez au moins deux joueurs.");
  }

  if (errors.length === 0) {
    const imposed = imposedRoundCount(format, playerCount);
    if (imposed !== null) {
      // Circle method: the schedule is fully determined, so the only valid
      // round count is the one it produces. No guard, no degraded mode.
      if (roundsPlanned !== imposed) {
        errors.push(
          `Ce format joue toutes les rencontres : avec ${playerCount} joueurs, ` +
          `il compte exactement ${imposed} ronde(s).`
        );
      }
    } else {
      const check = validateRoundCount(playerCount, roundsPlanned);
      if (check.blocked) {
        errors.push(
          `${check.message} Maximum pour ${playerCount} joueurs : ${check.max} ronde(s).`
        );
      } else if (check.warning) {
        warnings.push(
          `Avec ${playerCount} joueurs, au moins ${check.recommended} rondes sont recommandees ` +
          "pour degager un vainqueur net. La creation reste possible."
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
