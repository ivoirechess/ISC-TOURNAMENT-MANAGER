import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deletionAllowed } from "../src/tournament-lifecycle.js";

const sql = readFileSync(new URL("../supabase/migrations/20260810120000_tournament_recovery.sql", import.meta.url), "utf8");

test("la réouverture est verrouillée, auditée et réservée au super-admin", () => {
  assert.match(sql, /create or replace function public\.reopen_tournament/);
  assert.match(sql, /if not public\.is_super_admin\(\)/);
  assert.match(sql, /for update/);
  assert.match(sql, /status='ongoing', finished_at=null/);
  assert.match(sql, /tournament_reopen_log/);
  assert.match(sql, /validated_at=null, validated_by=null/);
});

test("la suppression serveur applique états, raison, auteur et nom exact", () => {
  for (const invariant of ["deleted_by", "deletion_reason", "previous_status", "p_confirmation_name", "t.status='ongoing'", "t.status='archived'"]) {
    assert.ok(sql.includes(invariant), invariant);
  }
  assert.match(sql, /revoke execute on function public\.soft_delete_tournament\(uuid\) from authenticated/);
});

test("les actions de suppression correspondent aux états autorisés", () => {
  assert.equal(deletionAllowed({ status: "draft" }, "admin"), true);
  assert.equal(deletionAllowed({ status: "ongoing" }, "admin"), false);
  assert.equal(deletionAllowed({ status: "archived" }, "admin"), false);
  assert.equal(deletionAllowed({ status: "archived" }, "super_admin"), true);
});
