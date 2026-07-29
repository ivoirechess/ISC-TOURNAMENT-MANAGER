// Standings screen — public, read-only. Data comes from src/data.js, the
// ordering from src/tiebreaks.js (pure). Nothing here writes anything.

import { getTournamentResults } from "../data.js";
import { computeStandings, TIEBREAK_LABELS } from "../tiebreaks.js";
import { STATUS_LABELS } from "../tournament-list.js";

function el(id) {
  return document.getElementById(id);
}

// Whole numbers stay plain, halves keep one decimal: 2 and 2.5, not 2.0.
function formatValue(value) {
  if (value === null || value === undefined) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function renderTable(rows, selectedTiebreaks) {
  const table = el("standings-table");
  table.innerHTML = "";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  // Points always leads, then the chosen tie-breaks in the chosen order.
  for (const heading of ["#", "Joueur", "Points", ...selectedTiebreaks.map((k) => TIEBREAK_LABELS[k] ?? k)]) {
    const cell = document.createElement("th");
    cell.textContent = heading;
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (const row of rows) {
    const line = document.createElement("tr");
    const cells = [
      String(row.rank),
      row.name,
      formatValue(row.points),
      ...selectedTiebreaks.map((key) => formatValue(row[key])),
    ];
    for (const value of cells) {
      const cell = document.createElement("td");
      cell.textContent = value;
      line.append(cell);
    }
    body.append(line);
  }
  table.append(body);
}

/** Called by the router; `id` is the tournament id from the hash. */
export async function openStandings(id) {
  el("standings-title").textContent = "Chargement…";
  el("standings-meta").textContent = "";
  el("standings-error").textContent = "";
  el("standings-table").innerHTML = "";
  el("standings-back").href = `#/tournoi/${encodeURIComponent(id)}`;

  let payload;
  try {
    payload = await getTournamentResults(id);
  } catch (err) {
    el("standings-title").textContent = "Classement";
    el("standings-error").textContent = err.message;
    return;
  }

  if (!payload) {
    el("standings-title").textContent = "Tournoi introuvable";
    return;
  }

  const { tournament, state } = payload;
  el("standings-title").textContent = `Classement — ${tournament.name}`;

  // A draft has nothing to rank yet: no round has been played.
  if (tournament.status === "draft") {
    el("standings-meta").textContent =
      "Ce tournoi est encore un brouillon : le classement s'affichera dès la première ronde jouée.";
    return;
  }

  const selectedTiebreaks = tournament.tiebreaks ?? [];
  el("standings-meta").textContent =
    `${STATUS_LABELS[tournament.status] ?? tournament.status} · départages : ` +
    `Points, ${selectedTiebreaks.map((k) => TIEBREAK_LABELS[k] ?? k).join(", ")}, ` +
    "puis ordre alphabétique.";

  try {
    renderTable(computeStandings(state, selectedTiebreaks), selectedTiebreaks);
  } catch (err) {
    el("standings-error").textContent = err.message;
  }
}
