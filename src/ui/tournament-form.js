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
import {
  TIEBREAK_KEYS,
  TIEBREAK_LABELS,
  validateTiebreakSelection,
} from "../tiebreaks.js";

function el(id) {
  return document.getElementById(id);
}

let players = [];
const selected = new Set();
const STEP_LABELS = ["Informations générales", "Format et cadence", "Départages", "Joueurs", "Vérification", "Enregistrement", "Publication facultative"];
let currentStep = 0;
let submitting = false;
let requestId = crypto.randomUUID();

// Ordered tie-break selection. Two are mandatory, six at most; the ordinal
// labels ("1er départage", "2e départage"…) follow this list.
const MIN_TIEBREAKS = 2;
const MAX_TIEBREAKS = 6;
let tiebreaks = ["buchholz", "sonnebornBerger"];
function refreshTiebreakValidation() {
  const check = validateTiebreakSelection(tiebreaks);
  el("t-errors").textContent = check.errors.join(" ");
}

function ordinalLabel(position) {
  return position === 0 ? "1er départage" : `${position + 1}e départage`;
}

function renderTiebreakSelects() {
  const box = el("tiebreak-selects");
  box.innerHTML = "";

  tiebreaks.forEach((chosen, position) => {
    const row = document.createElement("label");
    row.className = "tiebreak-row";
    row.textContent = `${ordinalLabel(position)} `;

    const select = document.createElement("select");
    // A tie-break already used elsewhere is not offered again, so the
    // selection can never hold a duplicate.
    const takenElsewhere = new Set(tiebreaks.filter((_, i) => i !== position));
    for (const key of TIEBREAK_KEYS) {
      if (takenElsewhere.has(key)) continue;
      const option = document.createElement("option");
      option.value = key;
      option.textContent = TIEBREAK_LABELS[key];
      option.selected = key === chosen;
      select.append(option);
    }
    select.addEventListener("change", () => {
      tiebreaks[position] = select.value;
      renderTiebreakSelects();
      refreshTiebreakValidation();
    });

    row.append(select);
    box.append(row);
  });

  el("tiebreak-add").disabled = tiebreaks.length >= MAX_TIEBREAKS;
  el("tiebreak-remove").disabled = tiebreaks.length <= MIN_TIEBREAKS;
}

function addTiebreak() {
  if (tiebreaks.length >= MAX_TIEBREAKS) return;
  const next = TIEBREAK_KEYS.find((key) => !tiebreaks.includes(key));
  if (!next) return;
  tiebreaks.push(next);
  renderTiebreakSelects();
  refreshTiebreakValidation();
}

function removeTiebreak() {
  if (tiebreaks.length <= MIN_TIEBREAKS) return;
  tiebreaks.pop();
  renderTiebreakSelects();
  refreshTiebreakValidation();
}

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
    input.addEventListener("change", () => { syncRoundsField(); el("t-errors").textContent = ""; });
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

function optionalNumber(id) {
  const value = Number.parseInt(el(id).value, 10);
  return Number.isInteger(value) ? value : null;
}

function renderWizard() {
  for (const page of document.querySelectorAll(".wizard-page")) page.hidden = Number(page.dataset.step) !== currentStep;
  const steps = el("wizard-steps"); steps.innerHTML = "";
  STEP_LABELS.forEach((label, index) => { const item = document.createElement("span"); item.textContent = `${index + 1}. ${label}`; item.className = index === currentStep ? "active" : ""; steps.append(item); });
  el("wizard-prev").disabled = currentStep === 0 || submitting;
  el("wizard-next").hidden = currentStep === STEP_LABELS.length - 1;
  el("t-submit").hidden = currentStep !== STEP_LABELS.length - 1;
  if (currentStep === 4) {
    const draft = currentDraft();
    el("t-review").textContent = `${draft.name || "Sans nom"} · ${draft.format} · ${draft.roundsPlanned} ronde(s) · ${selected.size} participant(s) · ${tiebreaks.length} départage(s).`;
  }
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
  const tiebreakCheck = validateTiebreakSelection(tiebreaks);
  const allErrors = [...errors, ...tiebreakCheck.errors];
  const maxPlayers = optionalNumber("t-max-players");
  if (maxPlayers !== null && selected.size > maxPlayers) allErrors.push("Le maximum de joueurs est dépassé.");
  el("t-errors").textContent = allErrors.join(" ");
  el("t-warnings").textContent = warnings.join(" ");
  return allErrors.length === 0;
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
  if (submitting || !refreshValidation()) return;

  const submitButton = el("t-submit");
  submitting = true;
  submitButton.disabled = true;
  try {
    const draft = currentDraft();
    const tournament = await createTournament({
      name: draft.name,
      description: el("t-description").value.trim() || null,
      startsAt: el("t-starts").value ? new Date(el("t-starts").value).toISOString() : null,
      city: el("t-city").value.trim() || null,
      venueName: el("t-venue").value.trim() || null,
      venueAddress: el("t-address").value.trim() || null,
      organizerName: el("t-organizer").value.trim() || null,
      publicContactEmail: el("t-contact").value.trim() || null,
      registrationUrl: el("t-registration").value.trim() || null,
      posterUrl: el("t-poster").value.trim() || null,
      format: draft.format,
      cadence: el("t-cadence").value,
      timeControlText: el("t-time-control").value.trim() || null,
      rankingType: el("t-ranking").value,
      fideRated: el("t-fide-rated").checked,
      maxPlayers: optionalNumber("t-max-players"),
      roundsPlanned: draft.roundsPlanned,
      playerIds: [...selected],
      tiebreaks: [...tiebreaks],
      publishNow: el("t-publish").checked,
      requestId,
    });
    resetForm();
    window.location.hash = `#/tournoi/${tournament.id}`;
  } catch (err) {
    el("t-errors").textContent = err.message;
  } finally {
    submitting = false;
    submitButton.disabled = false;
    renderWizard();
  }
}

function resetForm() {
  el("tournament-form").reset();
  selected.clear();
  el("t-errors").textContent = "";
  el("t-warnings").textContent = "";
  refreshSelectionCount();
  // Clears a leftover locked rounds field from a round-robin creation.
  syncRoundsField();
  tiebreaks = ["buchholz", "sonnebornBerger"];
  currentStep = 0;
  requestId = crypto.randomUUID();
  renderTiebreakSelects();
  renderWizard();
}

/** Called once at startup. */
export function initTournamentForm() {
  renderFormatChoices();
  el("tournament-form").addEventListener("submit", onSubmit);
  el("t-name").addEventListener("input", () => { el("t-errors").textContent = ""; });
  el("t-rounds").addEventListener("input", () => { el("t-errors").textContent = ""; });
  el("player-search").addEventListener("input", renderPlayerList);
  el("np-add").addEventListener("click", onAddPlayer);
  el("tiebreak-add").addEventListener("click", addTiebreak);
  el("tiebreak-remove").addEventListener("click", removeTiebreak);
  el("wizard-prev").addEventListener("click", () => { if (!submitting && currentStep > 0) { currentStep -= 1; renderWizard(); } });
  el("wizard-next").addEventListener("click", () => {
    if (submitting) return;
    el("t-errors").textContent = "";
    if (currentStep === 0 && !el("t-name").value.trim()) { el("t-errors").textContent = "Le nom du tournoi est obligatoire."; return; }
    if (currentStep === 2 && !validateTiebreakSelection(tiebreaks).ok) { el("t-errors").textContent = validateTiebreakSelection(tiebreaks).errors.join(" "); return; }
    if (currentStep === 3 && !refreshValidation()) return;
    currentStep = Math.min(STEP_LABELS.length - 1, currentStep + 1); renderWizard();
  });
  renderTiebreakSelects();
  refreshSelectionCount();
  renderWizard();
}

/** Called by the router each time the view is shown. */
export async function openTournamentForm() {
  await reloadPlayers();
  syncRoundsField();
  el("t-errors").textContent = "";
  el("t-warnings").textContent = "";
  currentStep = 0;
  renderWizard();
}
