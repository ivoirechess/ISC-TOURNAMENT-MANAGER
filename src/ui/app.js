// Entry point: authentication + a minimal hash router.
// Routes:
//   #/                   home (public directory placeholder)
//   #/nouveau-tournoi    tournament creation (admins only, else redirected)
//   #/tournoi/<id>       tournament view (placeholder for now)
//   #/tournoi/<id>/classement  standings, public, once play has started
//   #/tournoi/<id>/modifier    editing, owner or super_admin only
//   #/corbeille                deleted tournaments, super_admin only

import { initAuth } from "./auth.js";
import { initTournamentForm, openTournamentForm } from "./tournament-form.js";
import { openHome } from "./home.js";
import { openStandings } from "./standings.js";
import { initTournamentEdit, openTournamentEdit } from "./tournament-edit.js";
import { openTrash } from "./trash.js";
import { getCurrentRole, getTournament, onAuthChange } from "../data.js";
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

async function showTournament(id) {
  showView("view-tournament");
  el("tournament-title").textContent = "Chargement…";
  el("tournament-meta").textContent = "";
  el("tournament-players").innerHTML = "";
  try {
    const tournament = await getTournament(id);
    if (!tournament) {
      el("tournament-title").textContent = "Tournoi introuvable";
      return;
    }
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
    for (const tp of tournament.tournament_players ?? []) {
      const item = document.createElement("li");
      item.textContent = tp.players?.name ?? tp.player_id;
      list.append(item);
    }
  } catch (err) {
    el("tournament-title").textContent = err.message;
  }
}

async function route() {
  const hash = window.location.hash;

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

async function init() {
  initTournamentForm();
  initTournamentEdit();
  window.addEventListener("hashchange", route);
  await initAuth();
  await route();
  try {
    // Leaving the admin-only view on logout.
    await onAuthChange(() => {
      route();
    });
  } catch {
    // Without configuration the site stays in public mode.
  }
}

init();
