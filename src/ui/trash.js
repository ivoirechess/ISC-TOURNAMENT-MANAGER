// Trash screen — super_admin only. Lists the tournaments marked deleted and
// offers to restore or destroy them. Every write goes through src/data.js;
// RLS is what actually restricts these rows and these actions.

import {
  listDeletedTournaments,
  restoreTournament,
  purgeTournament,
  getCurrentRole,
} from "../data.js";
import { confirmsPurge } from "../tournament-delete.js";
import { STATUS_LABELS } from "../tournament-list.js";
import { FORMATS } from "../tournament-validation.js";

function el(id) {
  return document.getElementById(id);
}

function setFeedback(message, isError) {
  const node = el("trash-feedback");
  node.textContent = message;
  node.className = isError ? "error" : "success";
}

function formatLabel(format) {
  return FORMATS.find((f) => f.value === format)?.label ?? format;
}

function deletedOn(tournament) {
  if (!tournament.deleted_at) return "";
  // Locale formatting only — no logic depends on it.
  return new Date(tournament.deleted_at).toLocaleString("fr-FR");
}

function renderRow(tournament, reload) {
  const row = document.createElement("div");
  row.className = "trash-row";

  const title = document.createElement("strong");
  title.textContent = tournament.name;

  const meta = document.createElement("small");
  meta.className = "muted";
  meta.textContent =
    `${formatLabel(tournament.format)} · ` +
    `${STATUS_LABELS[tournament.status] ?? tournament.status} · ` +
    `supprimé le ${deletedOn(tournament)}`;

  const actions = document.createElement("div");
  actions.className = "trash-actions";

  const restore = document.createElement("button");
  restore.textContent = "Restaurer";
  restore.addEventListener("click", async () => {
    restore.disabled = true;
    try {
      await restoreTournament(tournament.id);
      setFeedback(`« ${tournament.name} » restauré.`, false);
      await reload();
    } catch (err) {
      setFeedback(err.message, true);
      restore.disabled = false;
    }
  });

  const purge = document.createElement("button");
  purge.className = "danger";
  purge.textContent = "Supprimer définitivement";
  purge.addEventListener("click", async () => {
    // Retyping the name is what makes this deliberate: an irreversible
    // action must not ride on a reflex click.
    const typed = window.prompt(
      `Suppression définitive et irréversible de « ${tournament.name} », ` +
      "avec ses rondes et ses appariements.\n\n" +
      "Retapez le nom exact du tournoi pour confirmer :"
    );
    if (typed === null) return;
    if (!confirmsPurge(tournament, typed)) {
      setFeedback("Le nom saisi ne correspond pas : rien n'a été supprimé.", true);
      return;
    }
    purge.disabled = true;
    try {
      await purgeTournament(tournament.id);
      setFeedback(`« ${tournament.name} » supprimé définitivement.`, false);
      await reload();
    } catch (err) {
      setFeedback(err.message, true);
      purge.disabled = false;
    }
  });

  actions.append(restore, purge);
  row.append(title, meta, actions);
  return row;
}

async function reload() {
  const box = el("trash-list");
  box.innerHTML = "";
  let tournaments;
  try {
    tournaments = await listDeletedTournaments();
  } catch (err) {
    setFeedback(err.message, true);
    return;
  }
  if (tournaments.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "La corbeille est vide.";
    box.append(empty);
    return;
  }
  for (const tournament of tournaments) {
    box.append(renderRow(tournament, reload));
  }
}

/**
 * Called by the router. Returns false when the visitor is not a super_admin,
 * so the router can send them home. Interface guard only: the rows are
 * unreadable for anyone else anyway.
 */
export async function openTrash() {
  setFeedback("", false);
  el("trash-list").innerHTML = "";

  let role = null;
  try {
    role = await getCurrentRole();
  } catch {
    role = null;
  }
  if (role !== "super_admin") return false;

  await reload();
  return true;
}
