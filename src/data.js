// SINGLE module talking to Supabase (CLAUDE.md rule). Every other file goes
// through the functions exported here; none imports the Supabase client.
//
// The client library is loaded lazily from a CDN ES module: the static site
// has no build step, and Node tests can import this module without any
// network access as long as they don't call the functions below.

import { getSupabaseEnv } from "./config.js";

// Version pinned exactly: an unpinned tag would let the CDN swap the code
// that handles organizer passwords without any visible change here.
const SUPABASE_JS_CDN = "https://esm.sh/@supabase/supabase-js@2.111.0";

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { url, anonKey } = getSupabaseEnv();
      const { createClient } = await import(SUPABASE_JS_CDN);
      return createClient(url, anonKey);
    })();
  }
  return clientPromise;
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
// Email/password only. There is NO public sign-up: admin accounts are
// created by hand in Supabase, never by the site.

/**
 * Signs in with email/password. Resolves with the session, or throws a
 * user-displayable French message.
 */
export async function signIn(email, password) {
  const client = await getClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error("Connexion refusee : identifiants invalides.");
  }
  return data.session;
}

/** Signs the current user out. */
export async function signOut() {
  const client = await getClient();
  const { error } = await client.auth.signOut();
  if (error) {
    throw new Error("La deconnexion a echoue. Reessayez.");
  }
}

/** Current session, or null when browsing anonymously. */
export async function getSession() {
  const client = await getClient();
  const { data } = await client.auth.getSession();
  return data.session ?? null;
}

/**
 * Subscribes to session changes (sign-in, sign-out, token refresh).
 * The callback receives the session or null. Returns an unsubscribe function.
 */
export async function onAuthChange(callback) {
  const client = await getClient();
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    callback(session ?? null);
  });
  return () => data.subscription.unsubscribe();
}

/**
 * Role of the signed-in user as stored in profiles ('admin',
 * 'super_admin'), or null for anonymous visitors and accounts without a
 * profile row. The UI must rely on this, not on mere session presence —
 * and RLS remains the actual protection either way.
 */
export async function getCurrentRole() {
  const client = await getClient();
  const { data: userData } = await client.auth.getUser();
  const user = userData?.user;
  if (!user) return null;

  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (error || !data) return null;
  return data.role;
}
