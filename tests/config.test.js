import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveSupabaseEnv } from "../src/config.js";

const VALID = {
  VITE_SUPABASE_URL: "https://example.supabase.co",
  VITE_SUPABASE_ANON_KEY: "sb_publishable_test",
};

describe("resolveSupabaseEnv", () => {
  test("retourne url et anonKey depuis une source complete", () => {
    const env = resolveSupabaseEnv([VALID]);
    assert.equal(env.url, "https://example.supabase.co");
    assert.equal(env.anonKey, "sb_publishable_test");
  });

  test("respecte l'ordre de priorite des sources", () => {
    const override = {
      VITE_SUPABASE_URL: "https://first.supabase.co",
      VITE_SUPABASE_ANON_KEY: "sb_publishable_first",
    };
    const env = resolveSupabaseEnv([override, VALID]);
    assert.equal(env.url, "https://first.supabase.co");
  });

  test("ignore les sources absentes ou incompletes", () => {
    const incomplete = { VITE_SUPABASE_URL: "https://only-url.supabase.co" };
    const env = resolveSupabaseEnv([undefined, incomplete, VALID]);
    assert.equal(env.anonKey, "sb_publishable_test");
  });

  test("ignore les valeurs vides ou non-chaines", () => {
    const empty = { VITE_SUPABASE_URL: "  ", VITE_SUPABASE_ANON_KEY: 42 };
    const env = resolveSupabaseEnv([empty, VALID]);
    assert.equal(env.url, "https://example.supabase.co");
  });

  test("retire les espaces peripheriques", () => {
    const padded = {
      VITE_SUPABASE_URL: "  https://padded.supabase.co  ",
      VITE_SUPABASE_ANON_KEY: " sb_publishable_padded ",
    };
    const env = resolveSupabaseEnv([padded]);
    assert.equal(env.url, "https://padded.supabase.co");
    assert.equal(env.anonKey, "sb_publishable_padded");
  });

  test("leve une erreur explicite quand rien n'est configure", () => {
    assert.throws(() => resolveSupabaseEnv([undefined, {}]), /Configuration Supabase manquante/);
  });
});
