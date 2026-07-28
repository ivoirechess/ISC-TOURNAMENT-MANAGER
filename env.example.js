// Static-hosting equivalent of .env.example. Copy this file to env.js
// (gitignored) and fill in the values — both are PUBLIC by design: RLS
// protects the data, not the secrecy of the anon key.
// The service_role key must NEVER appear here or anywhere in the repo.
globalThis.__ENV__ = {
  VITE_SUPABASE_URL: "https://ychyzekizjnlyqkisdim.supabase.co",
  VITE_SUPABASE_ANON_KEY: "sb_publishable_7f237d9U4aQ-DykDasIHjg_zRMfn4HT",
};
