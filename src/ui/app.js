// Entry point: authentication + a minimal hash router.
// Routes:
//   #/                   home (public directory placeholder)
//   #/nouveau-tournoi    tournament creation (admins only, else redirected)
//   #/tournoi/<id>       tournament view: pairings, results, live
//   #/tournoi/<id>/classement  standings, public, once play has started
//   #/tournoi/<id>/modifier    editing, owner or super_admin only
//   #/corbeille                deleted tournaments, super_admin only

import { initAuth } from "./auth.js";
import { initTournamentForm, openTournamentForm } from "./tournament-form.js";
import { openHome } from "./home.js";
import { openStandings } from "./standings.js";
import { initTournamentEdit, openTournamentEdit } from "./tournament-edit.js";
import { openTrash } from "./trash.js";
import { openRounds, closeRounds } from "./rounds.js";
import { openLifecycleActions } from "./lifecycle-actions.js";
import { getCurrentRole, getTournamentResults, onAuthChange } from "../data.js";
import { isAdminRole } from "../roles.js";
import { FORMATS } from "../tournament-validation.js";
import { STATUS_LABELS } from "../tournament-list.js";

function el(id) {
  return document.getElementById(id);
}

// A malformed hash (#/tournoi/%) makes decodeURIComponent throw; the raw
// segment is a good enough fallback, and the lookup simply finds nothing.
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const VIEWS = [
  "view-home",
  "view-new-tournament",
  "view-tournament",
  "view-tournament-edit",
  "view-standings",
  "view-trash",
];

function showView(id) {
  for (const view of VIEWS) {
    el(view).hidden = view !== id;
  }
}

async function showTournament(id, options = {}) {
  showView("view-tournament");
  el("tournament-title").textContent = "Chargement…";
  el("tournament-meta").textContent = "";
  el("tournament-players").innerHTML = "";
  el("rounds-board").innerHTML = "";
  el("rounds-tabs").innerHTML = "";
  // Cleared here and not only by the module that fills them: a tournament
  // that fails to load must not leave the previous one's buttons — nor the
  // message of the transition it just ran — on screen.
  el("tournament-actions").innerHTML = "";
  el("tournament-actions-feedback").textContent = "";
  try {
    const payload = await getTournamentResults(id);
    if (!payload) {
      el("tournament-title").textContent = "Tournoi introuvable";
      return;
    }
    const { tournament } = payload;
    el("tournament-title").textContent = tournament.name;
    const formatLabel = FORMATS.find((f) => f.value === tournament.format)?.label ?? tournament.format;
    const statusLabel = STATUS_LABELS[tournament.status] ?? tournament.status;
    el("tournament-meta").textContent =
      `Format ${formatLabel} · ${tournament.rounds_planned} rondes prévues · statut : ${statusLabel}`;
    // Standings only make sense once play has started.
    const standingsSlot = el("tournament-standings-link");
    standingsSlot.innerHTML = "";
    if (tournament.status === "ongoing" || tournament.status === "archived") {
      const link = document.createElement("a");
      link.className = "button-link";
      link.href = `#/tournoi/${encodeURIComponent(tournament.id)}/classement`;
      link.textContent = "Voir le classement";
      standingsSlot.append(link);
    }

    // Edit link for admins only — added to the DOM rather than hidden in
    // CSS. Ownership is still decided server-side: a non-owning admin who
    // follows the link gets a screen whose every write is refused.
    let role = null;
    try {
      role = await getCurrentRole();
    } catch {
      role = null;
    }
    if (isAdminRole(role)) {
      const editLink = document.createElement("a");
      editLink.href = `#/tournoi/${encodeURIComponent(tournament.id)}/modifier`;
      editLink.textContent = "Modifier ce tournoi";
      standingsSlot.append(" ", editLink);
    }

    const list = el("tournament-players");
    for (const player of payload.state.players) {
      const item = document.createElement("li");
      item.textContent = player.name;
      list.append(item);
    }

    // Life-cycle buttons (publish, start, cancel…). A transition changes the
    // tournament under our feet, so the module reloads this whole view
    // rather than patching the row it just moved; `focusRound` is how a
    // start lands on the round it has just drawn.
    await openLifecycleActions(tournament, ({ focusRound } = {}) =>
      showTournament(id, { focusRound })
    );

    await openRounds(payload, { focusRound: options.focusRound });
  } catch (err) {
    el("tournament-title").textContent = err.message;
  }
}

async function route() {
  const hash = window.location.hash;
  // Leaving the tournament view drops its realtime channel.
  if (!/^#\/tournoi\/[^/]+$/.test(hash)) closeRounds();

  if (hash === "#/nouveau-tournoi") {
    // Interface guard only — RLS is the real protection. Rely on the role
    // stored in profiles, never on mere session presence.
    let role = null;
    try {
      role = await getCurrentRole();
    } catch {
      role = null;
    }
    if (!isAdminRole(role)) {
      window.location.hash = "#/";
      return;
    }
    showView("view-new-tournament");
    await openTournamentForm();
    return;
  }

  if (hash === "#/corbeille") {
    showView("view-trash");
    // Not a super_admin: back home. The rows are unreadable for anyone else
    // anyway — this only avoids showing an empty screen with no explanation.
    if (!(await openTrash())) {
      window.location.hash = "#/";
    }
    return;
  }

  const editMatch = hash.match(/^#\/tournoi\/(.+)\/modifier$/);
  if (editMatch) {
    const id = safeDecode(editMatch[1]);
    showView("view-tournament-edit");
    // Not an owner (or not an admin at all): back to the public view.
    if (!(await openTournamentEdit(id))) {
      window.location.hash = `#/tournoi/${encodeURIComponent(id)}`;
    }
    return;
  }

  const standingsMatch = hash.match(/^#\/tournoi\/(.+)\/classement$/);
  if (standingsMatch) {
    showView("view-standings");
    await openStandings(safeDecode(standingsMatch[1]));
    return;
  }

  const tournamentMatch = hash.match(/^#\/tournoi\/(.+)$/);
  if (tournamentMatch) {
    await showTournament(safeDecode(tournamentMatch[1]));
    return;
  }

  showView("view-home");
  await openHome();
}

// Startup must not be all-or-nothing. `init` used to call the view
// initialisers before initAuth, with nothing catching a throw: one missing
// element in a screen the visitor was not even looking at left the whole
// sign-in path unbound, so clicking "Connexion organisateur" did nothing at
// all — no dialog, no message, the failure visible only in the console.
//
// Each step is now isolated, sign-in is wired first, and a step that fails
// says so on the page instead of taking the rest down with it.
function startupFailure(step, error) {
  console.error(`Initialisation « ${step} » : ${error?.message ?? error}`);
  const banner = el("startup-error");
  if (!banner) return;
  banner.hidden = false;
  banner.textContent =
    "Une partie de l'interface n'a pas pu démarrer " +
    `(${step}). Rechargez la page ; si le problème persiste, signalez ce ` +
    `message : ${error?.message ?? error}`;
}

async function step(name, run) {
  try {
    await run();
    return true;
  } catch (error) {
    startupFailure(name, error);
    return false;
  }
}

async function init() {
  // Sign-in first: whatever else fails, the organizer can still log in.
  await step("connexion", initAuth);

  await step("formulaire de création", initTournamentForm);
  await step("écran de modification", initTournamentEdit);

  window.addEventListener("hashchange", route);
  await step("affichage de la page", route);

  try {
    // Leaving the admin-only view on logout.
    await onAuthChange(() => {
      route();
    });
  } catch {
    // Without configuration the site stays in public mode.
  }
}

init().catch((error) => startupFailure("démarrage", error));
