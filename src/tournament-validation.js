// Tournament creation rules. PURE LOGIC — no DOM, no Supabase.
// Round-count guards delegate to the engine (src/swiss.js), which is the
// single source of truth for them.
//
// Reminder (CLAUDE.md): these checks are interface comfort; RLS decides
// server-side who may actually create anything.

import { validateRoundCount } from "./swiss.js";

// v1: only Swiss is playable; the other formats stay visible but disabled
// in the UI ("Bientot disponible"), per CLAUDE.md decision #4.
export const FORMATS = [
  { value: "swiss", label: "Suisse", enabled: true },
  { value: "round_robin", label: "Toutes rondes", enabled: false },
  { value: "knockout", label: "Coupe", enabled: false },
  { value: "double_round_robin", label: "Aller-retour", enabled: false },
];

export function isFormatAvailable(format) {
  return FORMATS.some((f) => f.value === format && f.enabled);
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
    errors.push("Ce format n'est pas encore disponible. Seul le format Suisse est ouvert pour l'instant.");
  }
  if (!Number.isInteger(roundsPlanned) || roundsPlanned < 1) {
    errors.push("Le nombre de rondes doit etre un entier superieur ou egal a 1.");
  }
  if (!Number.isInteger(playerCount) || playerCount < 2) {
    errors.push("Selectionnez au moins deux joueurs.");
  }

  if (errors.length === 0) {
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

  return { ok: errors.length === 0, errors, warnings };
}
