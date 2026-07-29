// Tournament creation screen. All data access goes through src/data.js;
// validation rules live in src/tournament-validation.js (pure).
//
// The admin-only guard here is interface comfort: RLS rejects the writes
// of anyone who is not an admin, whatever this screen displays.

import { listPlayers, createPlayer, createTournament } from "../data.js";
import {
  FORMATS,
  validateTournamentDraft,
  imposedRoundCount,
} from "../tournament-validation.js";

function el(id) {
  return document.getElementById(id);
}

let players = [];
const selected = new Set();

function renderFormatChoices() {
  const box = el("t-formats");
  box.innerHTML = "";
  for (const format of FORMATS) {
    const label = document.createElement("label");
    label.className = format.enabled ? "format-choice" : "format-choice disabled";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "format";
    input.value = format.value;
    input.disabled = !format.enabled;
    if (format.value === "swiss") input.checked = true;
    input.addEventListener("change", refreshValidation);
    label.append(input, ` ${format.label}`);
    if (!format.enabled) {
      const soon = document.createElement("small");
      soon.textContent = " — Bientôt disponible";
      label.append(soon);
    }
    box.append(label);
  }
}

function renderPlayerList() {
  const query = el("player-search").value.trim().toLowerCase();
  const box = el("player-list");
  box.innerHTML = "";
  const visible = players.filter((p) => p.name.toLowerCase().includes(query));
  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = players.length === 0
      ? "L'annuaire est vide : ajoutez un premier joueur ci-dessous."
      : "Aucun joueur ne correspond à cette recherche.";
    box.append(empty);
  }
  for (const player of visible) {
    const label = document.createElement("label");
    label.className = "player-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected.has(player.id);
    input.addEventListener("change", () => {
      if (input.checked) selected.add(player.id);
      else selected.delete(player.id);
      refreshSelectionCount();
      refreshValidation();
    });
    const details = [player.club, player.rating_std ? `Elo ${player.rating_std}` : null]
      .filter(Boolean).join(" · ");
    label.append(input, ` ${player.name}`);
    if (details) {
      const small = document.createElement("small");
      small.textContent = ` — ${details}`;
      label.append(small);
    }
    box.append(label);
  }
}

function refreshSelectionCount() {
  el("player-count").textContent =
    selected.size === 0 ? "Aucun joueur sélectionné." : `${selected.size} joueur(s) sélectionné(s).`;
}

function currentDraft() {
  const formatInput = document.querySelector('#t-formats input[name="format"]:checked');
  return {
    name: el("t-name").value,
    format: formatInput ? formatInput.value : "swiss",
    roundsPlanned: Number.parseInt(el("t-rounds").value, 10),
    playerCount: selected.size,
  };
}

// A round-robin plays every pairing, so its length follows from the player
// count: the field is filled in and locked rather than left to guesswork.
function syncRoundsField() {
  const formatInput = document.querySelector('#t-formats input[name="format"]:checked');
  const format = formatInput ? formatInput.value : "swiss";
  const roundsInput = el("t-rounds");
  const hint = el("t-rounds-hint");
  const imposed = imposedRoundCount(format, selected.size);

  if (imposed === null) {
    roundsInput.readOnly = false;
    hint.textContent = "";
    return;
  }
  roundsInput.readOnly = true;
  roundsInput.value = String(imposed);
  hint.textContent =
    `Ce format joue toutes les rencontres : le nombre de rondes découle du ` +
    `nombre de joueurs (${selected.size} joueur(s) → ${imposed} ronde(s)).`;
}

function refreshValidation() {
  syncRoundsField();
  const { errors, warnings } = validateTournamentDraft(currentDraft());
  el("t-errors").textContent = errors.join(" ");
  el("t-warnings").textContent = warnings.join(" ");
  return errors.length === 0;
}

async function reloadPlayers() {
  try {
    players = await listPlayers();
    el("players-error").textContent = "";
  } catch (err) {
    players = [];
    el("players-error").textContent = err.message;
  }
  renderPlayerList();
  refreshSelectionCount();
}

async function onAddPlayer() {
  const errorBox = el("np-error");
  errorBox.textContent = "";
  const name = el("np-name").value.trim();
  const club = el("np-club").value.trim();
  const elo = Number.parseInt(el("np-elo").value, 10);
  try {
    const player = await createPlayer({
      name,
      club: club || undefined,
      rating_std: Number.isInteger(elo) ? elo : undefined,
    });
    // The new player joins the directory and is selected right away.
    selected.add(player.id);
    el("np-name").value = "";
    el("np-club").value = "";
    el("np-elo").value = "";
    await reloadPlayers();
    refreshValidation();
  } catch (err) {
    errorBox.textContent = err.message;
  }
}

async function onSubmit(event) {
  event.preventDefault();
  if (!refreshValidation()) return;

  const submitButton = el("t-submit");
  submitButton.disabled = true;
  try {
    const draft = currentDraft();
    const tournament = await createTournament({
      name: draft.name,
      format: draft.format,
      roundsPlanned: draft.roundsPlanned,
      playerIds: [...selected],
    });
    resetForm();
    window.location.hash = `#/tournoi/${tournament.id}`;
  } catch (err) {
    el("t-errors").textContent = err.message;
  } finally {
    submitButton.disabled = false;
  }
}

function resetForm() {
  el("tournament-form").reset();
  selected.clear();
  el("t-errors").textContent = "";
  el("t-warnings").textContent = "";
  refreshSelectionCount();
}

/** Called once at startup. */
export function initTournamentForm() {
  renderFormatChoices();
  el("tournament-form").addEventListener("submit", onSubmit);
  el("t-name").addEventListener("input", refreshValidation);
  el("t-rounds").addEventListener("input", refreshValidation);
  el("player-search").addEventListener("input", renderPlayerList);
  el("np-add").addEventListener("click", onAddPlayer);
  refreshSelectionCount();
}

/** Called by the router each time the view is shown. */
export async function openTournamentForm() {
  await reloadPlayers();
  refreshValidation();
}
