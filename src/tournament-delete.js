// Deletion rules. PURE LOGIC — no DOM, no Supabase.
//
// Reminder (CLAUDE.md): these are interface comfort. RLS decides who may
// mark a tournament deleted, who may restore it and who may destroy it, and
// a trigger decides when a result may be emptied.

/**
 * Whether an individual result may be emptied back to null.
 *
 * Two conditions, both mirrored by the database trigger:
 *   - the tournament is running. A draft has nothing played, and an archive
 *     has published standings that emptying a game would silently rewrite;
 *   - the pairing is a real game holding a result. A bye is not a game, and
 *     an empty game has nothing to empty.
 */
export function canClearResult(tournament, pairing) {
  if (!tournament || !pairing) {
    return { ok: false, reason: "Appariement introuvable." };
  }
  if (tournament.status !== "ongoing") {
    return {
      ok: false,
      reason: "Un résultat ne peut être effacé que sur un tournoi en cours.",
    };
  }
  if (pairing.black === null || pairing.result === "bye") {
    return { ok: false, reason: "Un joueur exempt n'a pas de résultat à effacer." };
  }
  if (pairing.result === null || pairing.result === undefined) {
    return { ok: false, reason: "Cette partie n'a pas de résultat à effacer." };
  }
  return { ok: true, reason: null };
}

/** Wording of the deletion confirmation. It names the tournament, on purpose. */
export function deleteConfirmationMessage(tournament) {
  return (
    `Supprimer le tournoi « ${tournament.name} » ?\n\n` +
    "Il disparaîtra de l'annuaire public et de votre propre liste. " +
    "Seul un super-admin pourra le restaurer depuis la corbeille."
  );
}

/**
 * A permanent deletion asks for the tournament name to be typed back. The
 * comparison ignores surrounding blanks and case, but nothing else: the
 * point is to make the gesture deliberate, not to trap the typist.
 */
export function confirmsPurge(tournament, typedName) {
  if (!tournament || typeof typedName !== "string") return false;
  const normalize = (value) => value.trim().toLocaleLowerCase("fr");
  return normalize(typedName) !== "" && normalize(typedName) === normalize(tournament.name);
}
