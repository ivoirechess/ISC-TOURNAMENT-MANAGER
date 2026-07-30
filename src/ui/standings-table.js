import { TIEBREAK_LABELS } from "../tiebreaks.js";

export function formatStandingValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "number") return String(value);
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 6 }).format(value).replace(",", ".");
}

export function renderStandingsTable(table, rows, selectedTiebreaks = []) {
  table.replaceChildren();
  const columns = [
    { label: "Rang", shortLabel: "#", value: (row) => row.rank, className: "standing-rank" },
    { label: "Joueur", value: (row) => row.name, className: "standing-player" },
    { label: "Points", value: (row) => row.points, className: "standing-number" },
    ...selectedTiebreaks.map((key) => ({
      label: TIEBREAK_LABELS[key] ?? key,
      value: (row) => row[key],
      className: "standing-number standing-tiebreak",
    })),
  ];
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = column.shortLabel ?? column.label;
    cell.title = column.label;
    cell.setAttribute("aria-label", column.label);
    cell.className = column.className;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const line = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("td");
      cell.textContent = formatStandingValue(column.value(row));
      cell.dataset.label = column.label;
      cell.className = column.className;
      line.append(cell);
    }
    body.append(line);
  }
  table.append(head, body);
}
