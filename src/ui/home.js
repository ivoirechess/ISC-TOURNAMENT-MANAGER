// Professional public tournament directory. Data access stays in data.js;
// filtering, ordering and relative dates stay pure in tournament-list.js.

import { listTournaments, getCurrentRole, getCurrentUserId } from "../data.js";
import { isAdminRole } from "../roles.js";
import { FORMATS } from "../tournament-validation.js";
import {
  DIRECTORY_PAGE_SIZE,
  buildDirectory,
  buildDrafts,
  directoryState,
  normalizeDirectoryFilters,
  playerCount,
  relativeActivity,
} from "../tournament-list.js";
import { stateLabel } from "../tournament-lifecycle.js";

const TABS = [
  ["all", "Tous"], ["upcoming", "À venir"], ["ongoing", "En cours"],
  ["finished", "Terminés"], ["cancelled", "Annulés"], ["mine", "Mes tournois"],
];
const CADENCES = [["", "Toutes"], ["standard", "Classique"], ["rapid", "Rapide"], ["blitz", "Blitz"]];
let rows = [];
let user = { id: null, role: null };
let filters = normalizeDirectoryFilters();
let visibleCount = DIRECTORY_PAGE_SIZE;

function el(id) { return document.getElementById(id); }
function formatLabel(value) { return FORMATS.find((item) => item.value === value)?.label ?? value; }
function cadenceLabel(value) { return CADENCES.find((item) => item[0] === value)?.[1] ?? value ?? "Non précisée"; }
function dateLabel(value) {
  if (!value) return "À confirmer";
  return new Intl.DateTimeFormat("fr-CI", { dateStyle: "medium" }).format(new Date(value));
}

function setUrl() {
  const params = new URLSearchParams();
  if (filters.state !== "all") params.set("etat", filters.state);
  if (filters.query) params.set("q", filters.query);
  if (filters.format) params.set("format", filters.format);
  if (filters.cadence) params.set("cadence", filters.cadence);
  if (filters.year) params.set("annee", filters.year);
  const suffix = params.toString();
  history.replaceState(null, "", `${location.pathname}${location.search}#/${suffix ? `?${suffix}` : ""}`);
}

function statusBadge(row) {
  const badge = document.createElement("span");
  const state = directoryState(row);
  badge.className = `directory-status directory-status-${state}`;
  badge.textContent = stateLabel(row);
  return badge;
}

function activity(row) {
  const exact = row.last_activity_at ?? row.updated_at ?? row.created_at;
  const time = document.createElement("time");
  if (exact) {
    time.dateTime = exact;
    time.title = new Intl.DateTimeFormat("fr-CI", { dateStyle: "full", timeStyle: "short" }).format(new Date(exact));
  }
  time.textContent = relativeActivity(exact);
  return time;
}

function tournamentRow(row) {
  const tr = document.createElement("tr");
  const values = [
    ["Statut", statusBadge(row)],
    ["Tournoi", (() => { const a = document.createElement("a"); a.href = `#/tournoi/${encodeURIComponent(row.id)}`; a.textContent = row.name; a.className = "directory-name"; return a; })()],
    ["Date", dateLabel(row.starts_at)],
    ["Lieu", [row.venue_name, row.city].filter(Boolean).join(" · ") || "À confirmer"],
    ["Format", formatLabel(row.format)],
    ["Cadence", cadenceLabel(row.rating_type)],
    ["Joueurs", String(playerCount(row))],
    ["Dernière activité", activity(row)],
  ];
  for (const [label, value] of values) {
    const td = document.createElement("td");
    td.dataset.label = label;
    td.append(value instanceof Node ? value : document.createTextNode(value));
    tr.append(td);
  }
  return tr;
}

function renderTable(target, selectedRows, emptyText) {
  target.innerHTML = "";
  if (selectedRows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "directory-empty";
    empty.textContent = emptyText;
    target.append(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "directory-table";
  table.innerHTML = "<thead><tr><th>Statut</th><th>Tournoi</th><th>Date</th><th>Lieu</th><th>Format</th><th>Cadence</th><th>Joueurs</th><th>Dernière activité</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const row of selectedRows) body.append(tournamentRow(row));
  table.append(body);
  target.append(table);
}

function render() {
  const matches = buildDirectory(rows, filters, user.id);
  renderTable(el("directory-results"), matches.slice(0, visibleCount), "Aucun tournoi ne correspond à ces critères.");
  el("directory-count").textContent = `${matches.length} tournoi${matches.length === 1 ? "" : "s"}`;
  el("directory-more").hidden = visibleCount >= matches.length;
  for (const button of el("directory-tabs").querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.state === filters.state);
    button.setAttribute("aria-pressed", String(button.dataset.state === filters.state));
  }
  const drafts = buildDrafts(rows, user.id, user.role === "super_admin");
  el("drafts-section").hidden = drafts.length === 0;
  renderTable(el("draft-results"), drafts, "Aucun brouillon.");
}

function populateFilters() {
  const format = el("directory-format");
  format.innerHTML = '<option value="">Tous les formats</option>';
  for (const item of FORMATS.filter((entry) => entry.enabled)) format.add(new Option(item.label, item.value));
  const cadence = el("directory-cadence");
  cadence.innerHTML = "";
  for (const [value, label] of CADENCES) cadence.add(new Option(label, value));
  const years = [...new Set(rows.map((row) => (row.starts_at ?? row.created_at ?? "").slice(0, 4)).filter(Boolean))].sort().reverse();
  const year = el("directory-year");
  year.innerHTML = '<option value="">Toutes les années</option>';
  for (const value of years) year.add(new Option(value, value));
  el("directory-search").value = filters.query;
  format.value = filters.format; cadence.value = filters.cadence; year.value = filters.year;
}

function bindControls() {
  const tabs = el("directory-tabs");
  tabs.innerHTML = "";
  for (const [value, label] of TABS) {
    if (value === "mine" && !user.id) continue;
    const button = document.createElement("button");
    button.type = "button"; button.dataset.state = value; button.textContent = label;
    button.addEventListener("click", () => { filters.state = value; visibleCount = DIRECTORY_PAGE_SIZE; setUrl(); render(); });
    tabs.append(button);
  }
  for (const [id, key] of [["directory-search", "query"], ["directory-format", "format"], ["directory-cadence", "cadence"], ["directory-year", "year"]]) {
    const handler = (event) => {
      filters[key] = event.target.value.trim().toLocaleLowerCase("fr"); visibleCount = DIRECTORY_PAGE_SIZE; setUrl(); render();
    };
    if (id === "directory-search") el(id).oninput = handler;
    else el(id).onchange = handler;
  }
  el("directory-more").onclick = () => { visibleCount += DIRECTORY_PAGE_SIZE; render(); };
}

async function renderActions() {
  const slot = el("home-actions"); slot.innerHTML = "";
  if (!isAdminRole(user.role)) return;
  const create = document.createElement("a"); create.className = "button-link"; create.href = "#/nouveau-tournoi"; create.textContent = "Créer un tournoi"; slot.append(create);
  if (user.role === "super_admin") { const users = document.createElement("a");users.href="#/administration/utilisateurs";users.textContent="Utilisateurs";const trash = document.createElement("a"); trash.href = "#/corbeille"; trash.textContent = "Corbeille"; slot.append(" ",users," ", trash); }
}

/** Called by the router each time the home view is shown. */
export async function openHome() {
  const query = new URLSearchParams(location.hash.includes("?") ? location.hash.split("?")[1] : "");
  filters = normalizeDirectoryFilters({ state: query.get("etat"), query: query.get("q"), format: query.get("format"), cadence: query.get("cadence"), year: query.get("annee") });
  visibleCount = DIRECTORY_PAGE_SIZE;
  el("directory-loading").hidden = false; el("home-error").textContent = ""; el("directory-results").innerHTML = "";
  try {
    [rows, user.role, user.id] = await Promise.all([listTournaments(), getCurrentRole().catch(() => null), getCurrentUserId().catch(() => null)]);
    populateFilters(); bindControls(); render(); await renderActions();
  } catch (error) {
    el("home-error").textContent = error.message;
  } finally {
    el("directory-loading").hidden = true;
  }
}
