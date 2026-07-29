// Entry point: authentication + a minimal hash router.
// Routes:
//   #/                   home (public directory placeholder)
//   #/nouveau-tournoi    tournament creation (admins only, else redirected)
//   #/tournoi/<id>       tournament view (placeholder for now)

import { initAuth } from "./auth.js";
import { initTournamentForm, openTournamentForm } from "./tournament-form.js";
import { openHome } from "./home.js";
import { getCurrentRole, getTournament, onAuthChange } from "../data.js";
import { isAdminRole } from "../roles.js";
import { FORMATS } from "../tournament-validation.js";
import { STATUS_LABELS } from "../tournament-list.js";

function el(id) {
  return document.getElementById(id);
}

const VIEWS = ["view-home", "view-new-tournament", "view-tournament"];

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

  const tournamentMatch = hash.match(/^#\/tournoi\/(.+)$/);
  if (tournamentMatch) {
    await showTournament(decodeURIComponent(tournamentMatch[1]));
    return;
  }

  showView("view-home");
  await openHome();
}

async function init() {
  initTournamentForm();
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
