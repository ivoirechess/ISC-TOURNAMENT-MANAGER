import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDirectory,
  buildDrafts,
  normalizeDirectoryFilters,
  relativeActivity,
} from "../src/tournament-list.js";

const rows = [
  { id: "live-old", name: "Open Abidjan", status: "ongoing", last_activity_at: "2026-07-20T10:00:00Z", city: "Abidjan", organizer_name: "Ivoire Chess", format: "swiss", rating_type: "rapid", created_by: "u1" },
  { id: "live-new", name: "Championnat", status: "ongoing", last_activity_at: "2026-07-22T10:00:00Z", city: "Bouaké", format: "round_robin", rating_type: "standard", created_by: "u2" },
  { id: "soon-late", name: "Rentrée", status: "draft", published_at: "x", starts_at: "2026-09-12T10:00:00Z", venue_name: "Palais des sports", format: "swiss", rating_type: "blitz", created_by: "u1" },
  { id: "soon-first", name: "Club Yopougon", status: "draft", published_at: "x", starts_at: "2026-08-02T10:00:00Z", format: "swiss", rating_type: "rapid", tournament_players: [{ players: { club: "Cavalier Yop" } }], created_by: "u2" },
  { id: "done-new", name: "Finale", status: "archived", ends_at: "2025-12-12T10:00:00Z", created_by: "u1" },
  { id: "done-old", name: "Ancien", status: "archived", ends_at: "2025-05-01T10:00:00Z", created_by: "u2" },
  { id: "cancelled", name: "Annulé", status: "draft", published_at: "x", cancelled_at: "2026-01-01T10:00:00Z", created_by: "u1" },
  { id: "draft", name: "Secret", status: "draft", created_at: "2026-07-25T10:00:00Z", created_by: "u1" },
];

test("tri métier par défaut : activité, début, fin, sans brouillon", () => {
  assert.deepEqual(buildDirectory(rows).map((row) => row.id), [
    "live-new", "live-old", "soon-first", "soon-late", "done-new", "done-old", "cancelled",
  ]);
});

test("filtres état, propriétaire, format, cadence, année et recherche club", () => {
  assert.deepEqual(buildDirectory(rows, { state: "ongoing" }).map((row) => row.id), ["live-new", "live-old"]);
  assert.deepEqual(buildDirectory(rows, { state: "mine" }, "u1").map((row) => row.id), ["live-old", "soon-late", "done-new", "cancelled"]);
  assert.deepEqual(buildDirectory(rows, { query: "cavalier yop", cadence: "rapid", year: "2026" }).map((row) => row.id), ["soon-first"]);
  assert.deepEqual(buildDirectory(rows, { format: "round_robin" }).map((row) => row.id), ["live-new"]);
});

test("les brouillons restent dans la section privée", () => {
  assert.deepEqual(buildDrafts(rows, "u1").map((row) => row.id), ["draft"]);
  assert.deepEqual(buildDrafts(rows, null), []);
  assert.deepEqual(buildDrafts(rows, null, true).map((row) => row.id), ["draft"]);
});

test("normalisation URL et activité relative déterministe", () => {
  assert.deepEqual(normalizeDirectoryFilters({ state: "bad", query: "  ABIDJAN ", year: "26" }), {
    state: "all", query: "abidjan", format: "", cadence: "", year: "",
  });
  assert.equal(relativeActivity("2026-07-29T10:00:00Z", new Date("2026-07-29T12:00:00Z")), "il y a 2 heures");
  assert.equal(relativeActivity(null), "—");
});
