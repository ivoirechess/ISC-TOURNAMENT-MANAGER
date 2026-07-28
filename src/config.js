// Supabase configuration access. PURE resolution logic + a thin runtime
// getter. No secret ever lives here: only the public URL and the anon
// (publishable) key are expected, and they come from the environment.
//
// The site is static (no build step), so "environment variables" resolve
// from, in order:
//   1. import.meta.env  — ready for a future Vite/SvelteKit migration,
//      using the VITE_* names from .env.example
//   2. globalThis.__ENV__ — set by an uncommitted env.js (see
//      env.example.js), for plain static hosting and local dev

/**
 * Resolves the Supabase URL and anon key from a list of candidate sources.
 * Pure: takes plain objects, returns { url, anonKey } or throws.
 * @param {Array<object|undefined>} sources ordered by priority
 */
export function resolveSupabaseEnv(sources) {
  for (const source of sources) {
    if (!source) continue;
    const url = source.VITE_SUPABASE_URL;
    const anonKey = source.VITE_SUPABASE_ANON_KEY;
    if (typeof url === "string" && url.trim() !== "" &&
        typeof anonKey === "string" && anonKey.trim() !== "") {
      return { url: url.trim(), anonKey: anonKey.trim() };
    }
  }
  throw new Error(
    "Configuration Supabase manquante : definissez VITE_SUPABASE_URL et " +
    "VITE_SUPABASE_ANON_KEY (voir .env.example, ou copiez env.example.js " +
    "vers env.js pour un hebergement statique)."
  );
}

/** Runtime getter used by src/data.js. */
export function getSupabaseEnv() {
  return resolveSupabaseEnv([
    typeof import.meta !== "undefined" ? import.meta.env : undefined,
    globalThis.__ENV__,
  ]);
}
