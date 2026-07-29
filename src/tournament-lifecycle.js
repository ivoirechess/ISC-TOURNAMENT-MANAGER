// The five states a tournament moves through, and what may be done in each.
// PURE LOGIC — no DOM, no Supabase.
//
// Reminder (CLAUDE.md): interface comfort. The transitions themselves are
// database functions, and RLS decides who may call them.

/** State keys, in the order a tournament normally travels through them. */
export const STATES = ["draft", "upcoming", "ongoing", "finished", "cancelled"];

export const STATE_LABELS = {
  draft: "Brouillon",
  upcoming: "À venir",
  ongoing: "En cours",
  finished: "Terminé",
  cancelled: "Annulé",
};

/**
 * Which state a row is in.
 *
 * Cancellation wins over everything else: a tournament cancelled while it
 * was running is cancelled, not running. Otherwise the pair
 * (status, published_at) decides — a draft is private until it is published,
 * and publishing is what turns it into an announced, upcoming tournament.
 */
export function lifecycleState(tournament) {
  if (!tournament) return null;
  if (tournament.cancelled_at) return "cancelled";
  if (tournament.status === "archived") return "finished";
  if (tournament.status === "ongoing") return "ongoing";
  return tournament.published_at ? "upcoming" : "draft";
}

export function stateLabel(tournament) {
  const state = lifecycleState(tournament);
  return state ? STATE_LABELS[state] : "";
}

/**
 * Whether a visitor with no account can see this tournament at all.
 * An unpublished draft is the organizer's alone; a cancelled tournament
 * keeps its page only if it had been published — cancelling does not erase
 * something people may have linked to.
 *
 * This mirrors the SELECT policy; the policy is what actually enforces it.
 */
export function isPubliclyVisible(tournament) {
  if (!tournament || tournament.deleted_at) return false;
  if (tournament.published_at) return true;
  return tournament.status === "ongoing" || tournament.status === "archived";
}

/** A frozen tournament accepts no further writes at all. */
export function isFrozen(tournament) {
  const state = lifecycleState(tournament);
  return state === "finished" || state === "cancelled";
}

/** Entries may still be edited while the field is not yet playing. */
export function canEditEntries(tournament) {
  const state = lifecycleState(tournament);
  return state === "draft" || state === "upcoming";
}

/**
 * Actions offered to the owning organizer, in the order they appear.
 * The list is per state, exactly as specified — no action is offered that
 * the database would refuse.
 */
export const ACTIONS = {
  draft: ["save", "preview", "publish", "delete"],
  upcoming: ["unpublish", "start", "cancel"],
  ongoing: ["finish", "cancel"],
  finished: [],
  cancelled: [],
};

export const ACTION_LABELS = {
  save: "Enregistrer",
  preview: "Prévisualiser",
  publish: "Publier",
  delete: "Supprimer",
  unpublish: "Dépublier",
  start: "Démarrer",
  cancel: "Annuler le tournoi",
  finish: "Clôturer le tournoi",
};

/** Actions available on this tournament for someone allowed to manage it. */
export function availableActions(tournament) {
  const state = lifecycleState(tournament);
  return state ? [...ACTIONS[state]] : [];
}

/**
 * Actions the public tournament view offers, which is `availableActions`
 * minus the ones that already have a home elsewhere on the site:
 *
 *   - `save` and `preview` belong to the editing screen, which is where the
 *     fields being saved or previewed are;
 *   - `finish` is the closing button the rounds view already shows under the
 *     last round, next to the round it closes.
 *
 * Offering them twice would mean two buttons for one transition, and the
 * second one drifting out of step with the first.
 */
const ACTIONS_SHOWN_ELSEWHERE = ["save", "preview", "finish"];

export function viewActions(tournament) {
  return availableActions(tournament).filter(
    (action) => !ACTIONS_SHOWN_ELSEWHERE.includes(action)
  );
}

export function deletionAllowed(tournament, role) {
  if (!tournament || tournament.deleted_at) return false;
  if (role === "super_admin") return true;
  const state = lifecycleState(tournament);
  return role === "admin" && ["draft", "upcoming", "cancelled"].includes(state);
}

/**
 * Whether this visitor may be shown the life-cycle buttons: the owning
 * admin, or a super_admin on any tournament.
 *
 * Interface comfort, as always — the transitions re-check ownership
 * themselves and RLS refuses whatever this returns. Its job is to avoid
 * offering an organizer a « Publier » button whose only possible answer
 * would be a refusal, on someone else's tournament.
 */
export function canManageTournament(tournament, role, userId) {
  if (!tournament || tournament.deleted_at) return false;
  if (role === "super_admin") return true;
  if (role !== "admin") return false;
  return Boolean(userId) && tournament.created_by === userId;
}

/** Minimum field required before a tournament can start. */
export const MIN_PLAYERS_TO_START = 2;

/**
 * Why starting is refused, or null when it may go ahead. The same three
 * checks run inside start_tournament, which is the authority.
 */
export function startBlockedReason(tournament, activePlayerCount) {
  const state = lifecycleState(tournament);
  if (state === "cancelled") return "Un tournoi annulé ne démarre pas.";
  if (state !== "upcoming" && state !== "draft") {
    return "Ce tournoi a déjà démarré.";
  }
  if (!Number.isInteger(activePlayerCount) || activePlayerCount < MIN_PLAYERS_TO_START) {
    return `Il faut au moins ${MIN_PLAYERS_TO_START} joueurs actifs pour démarrer.`;
  }
  return null;
}

/** Confirmation shown before cancelling; it names the tournament. */
export function cancelConfirmationMessage(tournament) {
  return (
    `Annuler le tournoi « ${tournament.name} » ?\n\n` +
    "Il sera gelé : plus aucun résultat ne pourra être saisi. Sa page " +
    "publique reste en ligne si le tournoi avait été publié."
  );
}
