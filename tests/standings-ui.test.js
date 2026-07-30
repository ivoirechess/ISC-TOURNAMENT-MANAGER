import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatStandingValue } from "../src/ui/standings-table.js";

test("le format partagé protège les valeurs du classement", () => {
  assert.equal(formatStandingValue(null), "—");
  assert.equal(formatStandingValue(undefined), "—");
  assert.equal(formatStandingValue(Number.NaN), "—");
  assert.equal(formatStandingValue(5), "5");
  assert.equal(formatStandingValue(2.5), "2.5");
  assert.equal(formatStandingValue(2.125), "2.125");
  assert.equal(formatStandingValue("qualifié"), "qualifié");
});

test("les deux classements utilisent le même tableau sûr et les départages sélectionnés", () => {
  const shared = readFileSync(new URL("../src/ui/standings-table.js", import.meta.url), "utf8");
  const tournament = readFileSync(new URL("../src/ui/tournament-page.js", import.meta.url), "utf8");
  const standalone = readFileSync(new URL("../src/ui/standings.js", import.meta.url), "utf8");
  assert.match(shared, /selectedTiebreaks\.map/);
  assert.match(shared, /TIEBREAK_LABELS\[key\]/);
  assert.match(shared, /row\[key\]/);
  assert.match(shared, /textContent = formatStandingValue/);
  assert.match(tournament, /renderStandingsTable\(table, rows, payload\.tournament\.tiebreaks/);
  assert.match(standalone, /renderStandingsTable\(el\("standings-table"\), rows, selectedTiebreaks\)/);
  assert.doesNotMatch(tournament, /<th>#<\/th>/);
});

test("les actions d'accueil sont hors de la bannière et restent dans le flux", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles/main.css", import.meta.url), "utf8");
  const headingEnd = html.indexOf("</div>", html.indexOf('class="home-heading"'));
  assert.ok(html.indexOf('id="home-actions"') > headingEnd);
  assert.doesNotMatch(css, /#home-actions\s*\{[^}]*position\s*:\s*absolute/s);
});
