// Life-cycle buttons on the tournament view: publish, unpublish, start,
// cancel, delete.
//
// This is the screen that makes the life-cycle migration usable: without it
// a freshly created tournament is a draft nobody but its author can see, and
// nothing on the site turns it into an announced, then running, tournament.
//
// Every button calls a database function through src/data.js. Which states
// offer which actions is decided by src/tournament-lifecycle.js (pure), and
// who may actually run them is decided by RLS and by the functions
// themselves — what this module hides, the server still refuses.

import {
  cancelTournament,
  getCurrentRole,
  getCurrentUserId,
  publishTournament,
  reopenTournament,
  softDeleteTournament,
  startTournament,
  unpublishTournament,
} from "../data.js";
import {
  ACTION_LABELS,
  canManageTournament,
  cancelConfirmationMessage,
  stateLabel,
  viewActions,
  deletionAllowed,
} from "../tournament-lifecycle.js";
import { deleteConfirmationMessage } from "../tournament-delete.js";
import { isRoundRobin } from "../tournament-validation.js";

function el(id) {
  return document.getElementById(id);
}

/**
 * The only door to the data layer, in one object so the tests can drive the
 * buttons without a Supabase client. Production always uses this one; the
 * functions it names are the RPC wrappers, nothing else.
 */
export const LIVE_BACKEND = {
  role: getCurrentRole,
  userId: getCurrentUserId,
  publish: (id) => publishTournament(id),
  unpublish: (id) => unpublishTournament(id),
  start: (id) => startTournament(id),
  cancel: (id, reason) => cancelTournament(id, reason),
  delete: (id, reason, name) => softDeleteTournament(id, reason, name),
  reopen: (id, reason, reopenLastRound) => reopenTournament(id, reason, reopenLastRound),
};

// Wording per action: what the button says. « Démarrer » is spelled out
// here — ACTION_LABELS keeps it short for lists, but a button that launches
// a tournament had better say so in full.
const BUTTON_LABELS = {
  publish: ACTION_LABELS.publish,
  unpublish: ACTION_LABELS.unpublish,
  start: "Démarrer le tournoi",
  cancel: ACTION_LABELS.cancel,
  delete: ACTION_LABELS.delete,
  reopen: "Réouvrir le tournoi",
};

const BUTTON_HINTS = {
  publish: "Rend le tournoi visible dans l'annuaire public.",
  unpublish: "Retire l'annonce publique. Possible tant que le tournoi n'a pas démarré.",
  start: "Passe le tournoi en cours.",
  cancel: "Gèle le tournoi. Sa page publique reste en ligne s'il avait été publié.",
  delete: "Retire le tournoi de l'annuaire et de votre liste.",
  reopen: "Repasse le tournoi en cours afin de corriger ses résultats.",
};

const DONE_MESSAGES = {
  publish: "Tournoi publié : il apparaît maintenant dans l'annuaire.",
  unpublish: "Tournoi dépublié : il n'est plus visible du public.",
  cancel: "Tournoi annulé.",
  delete: "Tournoi supprimé.",
  reopen: "Tournoi rouvert. La ronde doit être validée puis le tournoi clôturé à nouveau.",
};

export function startHint(tournament) {
  return isRoundRobin(tournament?.format)
    ? "Passe le tournoi en cours et active le calendrier préparé."
    : "Passe le tournoi en cours et génère la ronde 1.";
}

export function startDoneMessage(tournament) {
  return isRoundRobin(tournament?.format)
    ? "Tournoi démarré. Le calendrier est maintenant actif."
    : "Tournoi démarré. Ronde 1 générée.";
}

// Actions that cannot be undone by clicking again, and are asked about first.
const DESTRUCTIVE = ["cancel", "delete"];

function setFeedback(message, isError) {
  const node = el("tournament-actions-feedback");
  node.textContent = message;
  node.className = isError ? "error" : "success";
}

/**
 * Confirmation for the destructive actions. Returns the extra arguments to
 * pass to the transition, or null when the organizer backs out.
 *
 * Cancelling asks for a reason, which is optional: an empty answer sends no
 * reason at all. Dismissing that second dialog aborts the cancellation —
 * someone who closes a window is not asking to go ahead anyway.
 */
export function confirmAction(action, tournament, dialogs = window) {
  if (action === "delete") {
    return dialogs.confirm(deleteConfirmationMessage(tournament)) ? [] : null;
  }
  if (action === "cancel") {
    if (!dialogs.confirm(cancelConfirmationMessage(tournament))) return null;
    const reason = dialogs.prompt(
      "Raison de l'annulation (facultative) — elle sera affichée sur la page du tournoi :",
      ""
    );
    if (reason === null) return null;
    const trimmed = String(reason).trim();
    return [trimmed === "" ? null : trimmed];
  }
  return [];
}

async function reopenArguments() {
  const dialog = el("reopen-tournament-dialog");
  const reason = el("reopen-tournament-reason");
  const feedback = el("reopen-tournament-feedback");
  reason.value = "";
  feedback.textContent = "";
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  return new Promise((resolve) => dialog.addEventListener("close", () => {
    const trimmed = reason.value.trim();
    if (dialog.returnValue !== "confirm") return resolve(null);
    if (!trimmed) {
      feedback.textContent = "La raison est obligatoire.";
      if (typeof dialog.showModal === "function") dialog.showModal();
      return resolve(null);
    }
    resolve([trimmed, el("reopen-last-round").checked]);
  }, { once: true }));
}

async function run({ action, tournament, buttons, backend, reload, dialogs, role }) {
  let args;
  if (action === "reopen") args = await reopenArguments();
  else if (action === "delete") {
    if (!dialogs.confirm(deleteConfirmationMessage(tournament))) return;
    let typed = null;
    if (role === "super_admin" || tournament.published_at) {
      typed = dialogs.prompt(`Retapez le nom exact du tournoi pour confirmer :\n${tournament.name}`);
      if (typed === null || typed !== tournament.name) {
        if (typed !== null) setFeedback("Le nom saisi ne correspond pas.", true);
        return;
      }
    }
    let reason = null;
    if (tournament.status === "ongoing" || tournament.status === "archived") {
      reason = dialogs.prompt("Raison obligatoire de la suppression :", "");
      if (!reason?.trim()) { setFeedback("La raison est obligatoire.", true); return; }
    }
    args = [reason?.trim() || null, typed];
  } else args = confirmAction(action, tournament, dialogs);
  if (args === null) return;

  // The whole group goes down, not just the button clicked: two transitions
  // fired at once on the same tournament would race, and the loser would
  // come back with a refusal that explains nothing.
  for (const button of buttons) button.disabled = true;
  setFeedback("Opération en cours…", false);

  try {
    await backend[action](tournament.id, ...args);
  } catch (error) {
    setFeedback(error.message, true);
    for (const button of buttons) button.disabled = false;
    return;
  }

  // A deleted tournament has no page left to show: RLS hides the row even
  // from its author, so staying here would only print "Tournoi introuvable".
  if (action === "delete") {
    setFeedback(DONE_MESSAGES.delete, false);
    dialogs.location.hash = "#/";
    return;
  }

  // Starting draws round 1 in the same transaction. Reload and open it, so
  // the arbiter lands on the boards they are about to fill in. The message
  // comes after the redraw, which would otherwise wipe it.
  await reload?.({ focusRound: action === "start" ? 1 : null });
  if (action === "reopen") el("tournament-reopened-banner").hidden = false;
  setFeedback(action === "start" ? startDoneMessage(tournament) : DONE_MESSAGES[action], false);
}

function renderButtons(tournament, actions, context) {
  const slot = el("tournament-actions");
  slot.innerHTML = "";
  if (actions.length === 0) return [];

  const group = document.createElement("div");
  group.className = "lifecycle-actions";

  const state = document.createElement("span");
  state.className = "lifecycle-state";
  state.textContent = stateLabel(tournament);
  group.append(state);

  const buttons = [];
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.textContent = BUTTON_LABELS[action];
    button.title = action === "start" ? startHint(tournament) : BUTTON_HINTS[action];
    button.className = DESTRUCTIVE.includes(action) ? "danger" : "primary";
    button.addEventListener("click", () =>
      run({ action, tournament, buttons, ...context })
    );
    buttons.push(button);
    group.append(button);
  }

  slot.append(group);
  return buttons;
}

/**
 * Called by the router once the tournament is loaded.
 *
 * `reload` is how this module asks the view to redraw itself after a
 * transition; it receives `{ focusRound }` so a start can land on the round
 * it has just created. `backend` and `dialogs` exist so the tests can drive
 * the same buttons without a Supabase client or a browser.
 */
export async function openLifecycleActions(
  tournament,
  reload,
  { backend = LIVE_BACKEND, dialogs = globalThis.window } = {}
) {
  el("tournament-actions").innerHTML = "";
  setFeedback("", false);
  if (!tournament) return [];

  let role = null;
  let userId = null;
  try {
    [role, userId] = await Promise.all([backend.role(), backend.userId()]);
  } catch {
    // Not signed in, or the session could not be read: the public view.
    role = null;
    userId = null;
  }
  if (!canManageTournament(tournament, role, userId)) return [];

  const actions = viewActions(tournament).filter((action) => action !== "delete");
  if (deletionAllowed(tournament, role)) actions.push("delete");
  if (role === "super_admin" && tournament.status === "archived" && !tournament.cancelled_at) {
    actions.unshift("reopen");
  }
  return renderButtons(tournament, actions, { backend, reload, dialogs, role });
}
