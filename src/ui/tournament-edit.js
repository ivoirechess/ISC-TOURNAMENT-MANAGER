// Tournament editing screen — owner (or super_admin) only. Every write goes
// through src/data.js; the rules live in src/tournament-edit.js (pure) and,
// above all, in database triggers. What this screen hides, the server still
// refuses.

import {
  getTournamentResults,
  getCurrentRole,
  renameTournament,
  updateRoundsPlanned,
  updatePairingResult,
} from "../data.js";
import { isAdminRole } from "../roles.js";
import {
  GAME_RESULTS,
  RESULT_LABELS,
  canEditRoundsPlanned,
  validateTournamentName,
  validateRoundsPlannedEdit,
  validateResultEdit,
} from "../tournament-edit.js";
import { STATUS_LABELS } from "../tournament-list.js";

function el(id) {
  return document.getElementById(id);
}

let current = null; // { tournament, state }

function setFeedback(id, message, isError) {
  const node = el(id);
  node.textContent = message;
  node.className = isError ? "error" : "success";
}

function renderRoundsSection() {
  const { tournament } = current;
  const editable = canEditRoundsPlanned(tournament);
  const input = el("edit-rounds");
  input.value = String(tournament.rounds_planned);
  input.disabled = !editable.ok;
  el("edit-rounds-save").disabled = !editable.ok;
  el("edit-rounds-reason").textContent = editable.ok ? "" : editable.reason;
}

// One row per played game, with a dropdown to correct the result. Byes are
// listed but not editable: they are not games, and the schema ties a null
// black player to the 'bye' result.
function renderResults() {
  const box = el("edit-results");
  box.innerHTML = "";

  const names = new Map(current.state.players.map((p) => [p.id, p.name]));
  let editableCount = 0;

  for (const round of current.state.rounds) {
    const played = round.pairings.filter((p) => p.result !== null && p.result !== undefined);
    if (played.length === 0) continue;

    const heading = document.createElement("h4");
    heading.textContent = `Ronde ${round.number}`;
    box.append(heading);

    for (const pairing of played) {
      const row = document.createElement("div");
      row.className = "result-row";

      const label = document.createElement("span");
      label.textContent =
        pairing.black === null
          ? `${names.get(pairing.white) ?? pairing.white} — exempt`
          : `${names.get(pairing.white) ?? pairing.white} vs ${names.get(pairing.black) ?? pairing.black}`;
      row.append(label);

      if (pairing.black === null) {
        const fixed = document.createElement("span");
        fixed.className = "muted";
        fixed.textContent = RESULT_LABELS.bye;
        row.append(fixed);
      } else {
        editableCount += 1;
        const select = document.createElement("select");
        for (const result of GAME_RESULTS) {
          const option = document.createElement("option");
          option.value = result;
          option.textContent = RESULT_LABELS[result];
          option.selected = result === pairing.result;
          select.append(option);
        }
        select.addEventListener("change", () => onResultChange(pairing, select));
        row.append(select);
      }

      box.append(row);
    }
  }

  if (editableCount === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Aucun résultat saisi pour l'instant.";
    box.append(empty);
  }
}

async function onResultChange(pairing, select) {
  const newResult = select.value;
  const check = validateResultEdit(pairing, newResult);
  if (!check.ok) {
    setFeedback("edit-results-feedback", check.errors.join(" "), true);
    select.value = pairing.result;
    return;
  }

  select.disabled = true;
  try {
    await updatePairingResult(pairing.id, newResult);
    pairing.result = newResult; // keep the local state in step
    setFeedback("edit-results-feedback", "Résultat corrigé.", false);
  } catch (err) {
    select.value = pairing.result; // put the dropdown back on the stored value
    setFeedback("edit-results-feedback", err.message, true);
  } finally {
    select.disabled = false;
  }
}

async function onRename(event) {
  event.preventDefault();
  const name = el("edit-name").value;
  const check = validateTournamentName(name);
  if (!check.ok) {
    setFeedback("edit-name-feedback", check.errors.join(" "), true);
    return;
  }
  try {
    const updated = await renameTournament(current.tournament.id, name);
    current.tournament.name = updated.name;
    el("edit-title").textContent = `Modifier — ${updated.name}`;
    setFeedback("edit-name-feedback", "Nom enregistré.", false);
  } catch (err) {
    setFeedback("edit-name-feedback", err.message, true);
  }
}

async function onSaveRounds(event) {
  event.preventDefault();
  const roundsPlanned = Number.parseInt(el("edit-rounds").value, 10);
  const playerCount = current.state.players.length;
  const check = validateRoundsPlannedEdit(current.tournament, roundsPlanned, playerCount);
  if (!check.ok) {
    setFeedback("edit-rounds-feedback", check.errors.join(" "), true);
    return;
  }
  try {
    const updated = await updateRoundsPlanned(current.tournament.id, roundsPlanned);
    current.tournament.rounds_planned = updated.rounds_planned;
    const warning = check.warning
      ? ` Au moins ${check.warning} rondes restent recommandées pour ${playerCount} joueurs.`
      : "";
    setFeedback("edit-rounds-feedback", `Nombre de rondes enregistré.${warning}`, false);
  } catch (err) {
    setFeedback("edit-rounds-feedback", err.message, true);
  }
}

/** Called once at startup. */
export function initTournamentEdit() {
  el("edit-name-form").addEventListener("submit", onRename);
  el("edit-rounds-form").addEventListener("submit", onSaveRounds);
}

/**
 * Called by the router. Returns false when the visitor may not edit this
 * tournament, so the router can send them back to the public view.
 */
export async function openTournamentEdit(id) {
  for (const node of ["edit-name-feedback", "edit-rounds-feedback", "edit-results-feedback"]) {
    el(node).textContent = "";
  }
  el("edit-title").textContent = "Chargement…";
  el("edit-results").innerHTML = "";
  el("edit-back").href = `#/tournoi/${encodeURIComponent(id)}`;

  // Interface guard only: RLS and the triggers decide what actually goes
  // through, whatever this screen chooses to show.
  let role = null;
  try {
    role = await getCurrentRole();
  } catch {
    role = null;
  }
  if (!isAdminRole(role)) return false;

  let payload;
  try {
    payload = await getTournamentResults(id);
  } catch (err) {
    el("edit-title").textContent = "Modifier";
    setFeedback("edit-name-feedback", err.message, true);
    return true;
  }
  if (!payload) {
    el("edit-title").textContent = "Tournoi introuvable";
    return true;
  }

  current = payload;
  const { tournament } = current;
  el("edit-title").textContent = `Modifier — ${tournament.name}`;
  el("edit-meta").textContent = `Statut : ${STATUS_LABELS[tournament.status] ?? tournament.status}`;
  el("edit-name").value = tournament.name;
  renderRoundsSection();
  renderResults();
  return true;
}
