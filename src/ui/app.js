// Entry point: authentication + a minimal hash router.
// Routes:
//   #/                   home (public directory placeholder)
//   #/nouveau-tournoi    tournament creation (admins only, else redirected)
//   #/tournoi/<id>       tournament view: pairings, results, live
//   #/tournoi/<id>/classement  standings, public, once play has started
//   #/tournoi/<id>/modifier    editing, owner or super_admin only
//   #/corbeille                deleted tournaments, super_admin only

import { initAuth } from "./auth.js";
import { captureAuthCallback, initPasswordSetup, isPasswordSetupPending, openPasswordSetup } from "./password-setup.js";
import { PASSWORD_SETUP_HASH } from "../auth-callback.js";
import { initTournamentForm, openTournamentForm } from "./tournament-form.js";
import { openHome } from "./home.js";
import { initTournamentEdit, openTournamentEdit } from "./tournament-edit.js";
import { openTrash } from "./trash.js";
import { openRounds, closeRounds } from "./rounds.js";
import { openLifecycleActions } from "./lifecycle-actions.js";
import { getCurrentClubIds, getCurrentRole, getCurrentUserId, getTournamentResults, onAuthChange } from "../data.js";
import { isAdminRole } from "../roles.js";
import { activateTournamentTab, renderTournamentPage } from "./tournament-page.js";
import { canShowOrganizerPanel, resolveTournamentTab, tournamentTabUrl } from "../tournament-page.js";
import { openPlayer, openPlayers } from "./players.js";
import { openClub, openClubs, openUserAdministration } from "./clubs.js";
import {downloadExport,pairingsExport,resultSheetsExport,standingsExport,startingListExport} from "../tournament-exports.js";

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

async function copyText(value){if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(value);return}catch{/* permission denied: use the static-site fallback */}}const input=document.createElement("textarea");input.value=value;input.setAttribute("readonly","");input.style.position="fixed";input.style.opacity="0";document.body.append(input);input.select();document.execCommand("copy");input.remove()}

const VIEWS = [
  "view-home",
  "view-new-tournament",
  "view-tournament",
  "view-tournament-edit",
  "view-standings",
  "view-trash",
  "view-players",
  "view-player",
  "view-clubs",
  "view-club",
  "view-user-administration",
  "view-password-setup",
];

function showView(id) {
  for (const view of VIEWS) {
    el(view).hidden = view !== id;
  }
}

async function showTournament(id, options = {}) {
  showView("view-tournament");
  el("tournament-title").textContent = "Chargement…";
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
    renderTournamentPage(payload);
    const identifier = tournament.slug || tournament.id;

    // Edit link for admins only — added to the DOM rather than hidden in
    // CSS. Ownership is still decided server-side: a non-owning admin who
    // follows the link gets a screen whose every write is refused.
    let role = null;
    let userId = null;
    let clubIds = [];
    try {
      [role, userId, clubIds] = await Promise.all([getCurrentRole(), getCurrentUserId(), getCurrentClubIds()]);
    } catch {
      role = null;
    }
    const organizer = canShowOrganizerPanel(tournament, role, userId, clubIds);
    el("organizer-panel").hidden = !organizer;
    el("tournament-edit-link").href = `#/tournoi/${encodeURIComponent(identifier)}/modifier`;

    // Life-cycle buttons (publish, start, cancel…). A transition changes the
    // tournament under our feet, so the module reloads this whole view
    // rather than patching the row it just moved; `focusRound` is how a
    // start lands on the round it has just drawn.
    if (organizer) await openLifecycleActions(tournament, ({ focusRound } = {}) => showTournament(identifier, { focusRound, tab: "pairings" }));

    await openRounds(payload, { focusRound: options.focusRound });
    const tab = resolveTournamentTab(options.tab);
    activateTournamentTab(identifier, tab, options.focusRound);
    for (const button of el("tournament-tabs").querySelectorAll("button")) {
      button.onclick = () => activateTournamentTab(identifier, button.dataset.tab, null);
    }
    el("copy-tournament-link").onclick = async () => {
      const currentTab = el("tournament-tabs").querySelector("button.active")?.dataset.tab ?? "overview";
      await copyText(new URL(tournamentTabUrl(identifier, currentTab, options.focusRound), location.href).href);
      el("copy-tournament-link").textContent = "Lien copié";
    };
    el("share-tournament").onclick = async () => {
      const currentTab = el("tournament-tabs").querySelector("button.active")?.dataset.tab ?? "overview";
      const url = new URL(tournamentTabUrl(identifier, currentTab, options.focusRound), location.href).href;
      if (navigator.share) await navigator.share({ title: tournament.name, url });
      else {await copyText(url);el("share-tournament").textContent="Lien copié";}
    };
    el("refresh-tournament").onclick=()=>showTournament(identifier,{focusRound:options.focusRound,tab:el("tournament-tabs").querySelector("button.active")?.dataset.tab});
    const exportAction=(id,factory)=>{el(id).onclick=()=>{try{downloadExport(factory(payload))}catch(error){el("tournament-actions-feedback").textContent=error.message}}};
    exportAction("export-starting-list",startingListExport);exportAction("export-pairings",pairingsExport);exportAction("export-standings",standingsExport);exportAction("export-result-sheets",resultSheetsExport);
  } catch (err) {
    el("tournament-title").textContent = err.message;
  }
}

async function route() {
  const hash = window.location.hash;
  const routeHash = hash.split("?")[0];
  // Leaving the tournament view drops its realtime channel.
  if (!/^#\/tournoi\/[^/]+$/.test(routeHash)) closeRounds();

  // An invitation or reset link preempts every route: an account without a
  // password could never sign in again, so nothing else opens until it has
  // one. The screen puts the hash back itself, so typing another route or
  // reloading changes nothing.
  if (isPasswordSetupPending()) {
    showView("view-password-setup");
    await openPasswordSetup();
    return;
  }
  if (routeHash === PASSWORD_SETUP_HASH) {
    // Reached without a link: there is no password to set here.
    window.location.hash = "#/";
    return;
  }

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

  if (routeHash === "#/joueurs") { showView("view-players"); await openPlayers(); return; }
  const playerMatch=routeHash.match(/^#\/joueur\/([^/]+)$/);
  if(playerMatch){showView("view-player");await openPlayer(safeDecode(playerMatch[1]));return;}
  if(routeHash==="#/clubs"){showView("view-clubs");await openClubs();return;}
  const clubMatch=routeHash.match(/^#\/club\/([^/]+)$/);
  if(clubMatch){showView("view-club");await openClub(safeDecode(clubMatch[1]));return;}
  if(routeHash==="#/administration/utilisateurs"){
    showView("view-user-administration");if(!(await openUserAdministration()))window.location.hash="#/";return;
  }

  const editMatch = routeHash.match(/^#\/tournoi\/(.+)\/modifier$/);
  if (editMatch) {
    const id = safeDecode(editMatch[1]);
    showView("view-tournament-edit");
    // Not an owner (or not an admin at all): back to the public view.
    if (!(await openTournamentEdit(id))) {
      window.location.hash = `#/tournoi/${encodeURIComponent(id)}`;
    }
    return;
  }

  const standingsMatch = routeHash.match(/^#\/tournoi\/(.+)\/classement$/);
  if (standingsMatch) {
    await showTournament(safeDecode(standingsMatch[1]), { tab: "standings" });
    return;
  }

  const tournamentMatch = routeHash.match(/^#\/tournoi\/(.+)$/);
  if (tournamentMatch) {
    const query = new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "");
    const parsedRound = Number.parseInt(query.get("ronde") ?? "", 10);
    await showTournament(safeDecode(tournamentMatch[1]), {
      focusRound: Number.isInteger(parsedRound) && parsedRound > 0 ? parsedRound : null,
      tab: resolveTournamentTab(query.get("onglet")),
    });
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
  // Before anything else, and before any Supabase call: the client wipes
  // `location.hash` the moment it initialises, and the invitation marker
  // lives nowhere but that fragment.
  await step("lien d'invitation", captureAuthCallback);

  // Sign-in first: whatever else fails, the organizer can still log in.
  await step("connexion", initAuth);

  await step("écran de mot de passe", initPasswordSetup);
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
