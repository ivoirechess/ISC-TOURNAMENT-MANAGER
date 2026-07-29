// Public home page: tournament directory in two sections, plus the
// organizer's "create" button. All data access goes through src/data.js.
//
// The create button is only ever ADDED to the DOM for admins (profiles
// role) — it is not merely hidden with CSS, in keeping with the
// read-only-public spirit. RLS remains the actual protection either way.

import { listTournaments, getCurrentRole } from "../data.js";
import { isAdminRole } from "../roles.js";
import { FORMATS } from "../tournament-validation.js";
import { STATUS_LABELS, groupTournaments, playerCount } from "../tournament-list.js";

function el(id) {
  return document.getElementById(id);
}

function formatLabel(format) {
  return FORMATS.find((f) => f.value === format)?.label ?? format;
}

function tournamentCard(row) {
  const card = document.createElement("a");
  card.className = "tournament-card";
  card.href = `#/tournoi/${encodeURIComponent(row.id)}`;

  const title = document.createElement("strong");
  title.textContent = row.name;

  const status = document.createElement("span");
  status.className = `status status-${row.status}`;
  status.textContent = STATUS_LABELS[row.status] ?? row.status;

  const meta = document.createElement("small");
  const count = playerCount(row);
  meta.textContent =
    `${formatLabel(row.format)} · ${row.rounds_planned} ronde(s) prévue(s) · ` +
    `${count} joueur(s) inscrit(s)`;

  card.append(title, status, meta);
  return card;
}

function renderSection(containerId, rows, emptyMessage) {
  const box = el(containerId);
  box.innerHTML = "";
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = emptyMessage;
    box.append(empty);
    return;
  }
  for (const row of rows) {
    box.append(tournamentCard(row));
  }
}

async function renderCreateButton() {
  const slot = el("home-actions");
  slot.innerHTML = "";
  let role = null;
  try {
    role = await getCurrentRole();
  } catch {
    role = null;
  }
  if (!isAdminRole(role)) return;

  const link = document.createElement("a");
  link.className = "button-link";
  link.href = "#/nouveau-tournoi";
  link.textContent = "Créer un tournoi";
  slot.append(link);
}

/** Called by the router each time the home view is shown. */
export async function openHome() {
  el("home-error").textContent = "";
  try {
    const { current, archives } = groupTournaments(await listTournaments());
    renderSection("current-tournaments", current, "Aucun tournoi en cours pour le moment.");
    renderSection("archived-tournaments", archives, "Aucun tournoi archivé pour le moment.");
  } catch (err) {
    renderSection("current-tournaments", [], "—");
    renderSection("archived-tournaments", [], "—");
    el("home-error").textContent = err.message;
  }
  await renderCreateButton();
}
