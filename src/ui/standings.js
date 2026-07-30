// Standings screen — public, read-only. Data comes from src/data.js, the
// ordering from src/tiebreaks.js (pure). Nothing here writes anything.

import { getTournamentResults } from "../data.js";
import { computeStandings, TIEBREAK_LABELS } from "../tiebreaks.js";
import { stateLabel } from "../tournament-lifecycle.js";
import { renderStandingsTable } from "./standings-table.js";

function el(id) {
  return document.getElementById(id);
}

function renderTable(rows, selectedTiebreaks) {
  renderStandingsTable(el("standings-table"), rows, selectedTiebreaks);
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
    `${stateLabel(tournament)} · départages : ` +
    `Points, ${selectedTiebreaks.map((k) => TIEBREAK_LABELS[k] ?? k).join(", ")}, ` +
    "puis ordre alphabétique.";

  try {
    renderTable(computeStandings(state, selectedTiebreaks), selectedTiebreaks);
  } catch (err) {
    el("standings-error").textContent = err.message;
  }
}
