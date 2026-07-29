// Home-page tournament listing rules. PURE LOGIC — no DOM, no Supabase.

/**
 * Number of registered players on a tournament row as returned by
 * src/data.js, where tournament_players carries a PostgREST count
 * aggregate: [{ count: n }]. Defensive: 0 when the shape is missing.
 */
export function playerCount(row) {
  const aggregate = row?.tournament_players;
  if (Array.isArray(aggregate) && Number.isInteger(aggregate[0]?.count)) {
    return aggregate[0].count;
  }
  return 0;
}

export const DIRECTORY_PAGE_SIZE = 20;
export const DIRECTORY_STATES = ["all", "upcoming", "ongoing", "finished", "cancelled", "mine"];

export function tournamentClubs(row) {
  return (row?.registrations ?? row?.tournament_players ?? [])
    .map((entry) => entry?.players?.club)
    .filter(Boolean);
}

export function normalizeDirectoryFilters(filters = {}) {
  return {
    state: DIRECTORY_STATES.includes(filters.state) ? filters.state : "all",
    query: String(filters.query ?? "").trim().toLocaleLowerCase("fr"),
    format: String(filters.format ?? ""),
    cadence: String(filters.cadence ?? ""),
    year: /^\d{4}$/.test(String(filters.year ?? "")) ? String(filters.year) : "",
  };
}

function directoryState(row) {
  if (row?.cancelled_at) return "cancelled";
  if (row?.status === "archived") return "finished";
  if (row?.status === "ongoing") return "ongoing";
  return row?.published_at ? "upcoming" : "draft";
}

function timestamp(row, state) {
  if (state === "ongoing") return row.last_activity_at ?? row.updated_at ?? row.created_at;
  if (state === "upcoming") return row.starts_at ?? row.created_at;
  if (state === "finished") return row.ends_at ?? row.finished_at ?? row.last_activity_at;
  return row.last_activity_at ?? row.updated_at ?? row.created_at;
}

/** Filters then sorts the public directory. Drafts are deliberately excluded. */
export function buildDirectory(rows, filters = {}, currentUserId = null) {
  const selected = normalizeDirectoryFilters(filters);
  const stateOrder = { ongoing: 0, upcoming: 1, finished: 2, cancelled: 3 };
  return (rows ?? [])
    .filter((row) => {
      const state = directoryState(row);
      if (state === "draft") return false;
      if (selected.state === "mine" && row.created_by !== currentUserId) return false;
      if (!['all', 'mine'].includes(selected.state) && state !== selected.state) return false;
      if (selected.format && row.format !== selected.format) return false;
      if (selected.cadence && row.rating_type !== selected.cadence) return false;
      const yearSource = row.starts_at ?? row.ends_at ?? row.created_at ?? "";
      if (selected.year && !String(yearSource).startsWith(selected.year)) return false;
      if (selected.query) {
        const haystack = [row.name, row.organizer_name, row.city, row.venue_name, ...tournamentClubs(row)]
          .filter(Boolean).join(" ").toLocaleLowerCase("fr");
        if (!haystack.includes(selected.query)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const stateA = directoryState(a);
      const stateB = directoryState(b);
      if (selected.state === "all" && stateA !== stateB) return stateOrder[stateA] - stateOrder[stateB];
      const dateA = timestamp(a, stateA) ?? "";
      const dateB = timestamp(b, stateB) ?? "";
      const ascending = stateA === "upcoming";
      if (dateA !== dateB) return ascending ? dateA.localeCompare(dateB) : dateB.localeCompare(dateA);
      return String(a.id).localeCompare(String(b.id));
    });
}

/** Private drafts, only for their owner (or every draft for a super-admin). */
export function buildDrafts(rows, currentUserId, isSuperAdmin = false) {
  if (!currentUserId && !isSuperAdmin) return [];
  return (rows ?? [])
    .filter((row) => directoryState(row) === "draft" && (isSuperAdmin || row.created_by === currentUserId))
    .sort((a, b) => String(timestamp(b, "draft") ?? "").localeCompare(String(timestamp(a, "draft") ?? "")));
}

/** Relative activity wording with deterministic `now` for tests. */
export function relativeActivity(value, now = new Date()) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const ranges = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  const formatter = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
  for (const [size, unit] of ranges) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, "second");
}

export { directoryState };

function byNewestFirst(a, b) {
  const dateA = a.created_at ?? "";
  const dateB = b.created_at ?? "";
  if (dateA < dateB) return 1;
  if (dateA > dateB) return -1;
  // Deterministic final order for identical timestamps.
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Legacy grouping helper, kept for callers outside the new directory:
 * ongoing, archived and draft rows stay in three strictly separate groups.
 * Rows with an unknown status are ignored rather than misfiled.
 */
export function groupTournaments(rows) {
  const current = [];
  const archives = [];
  const drafts = [];
  for (const row of rows ?? []) {
    if (row.status === "ongoing") current.push(row);
    else if (row.status === "archived") archives.push(row);
    else if (row.status === "draft") drafts.push(row);
  }
  current.sort(byNewestFirst);
  archives.sort(byNewestFirst);
  drafts.sort(byNewestFirst);
  return { current, archives, drafts };
}
