import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAdminRole, roleLabel, ADMIN_ROLES } from "../src/roles.js";

describe("isAdminRole", () => {
  test("vrai pour admin et super_admin", () => {
    assert.equal(isAdminRole("admin"), true);
    assert.equal(isAdminRole("super_admin"), true);
  });

  test("faux pour tout le reste, y compris une simple session sans role", () => {
    assert.equal(isAdminRole(null), false);
    assert.equal(isAdminRole(undefined), false);
    assert.equal(isAdminRole(""), false);
    assert.equal(isAdminRole("public"), false);
    assert.equal(isAdminRole("Admin"), false);
    assert.equal(isAdminRole("superadmin"), false);
  });

  test("ADMIN_ROLES correspond exactement aux roles du schema", () => {
    assert.deepEqual([...ADMIN_ROLES].sort(), ["admin", "super_admin"]);
  });
});

describe("roleLabel", () => {
  test("libelles francais par role", () => {
    assert.equal(roleLabel("super_admin"), "Super-admin");
    assert.equal(roleLabel("admin"), "Organisateur");
    assert.equal(roleLabel(null), "Visiteur");
    assert.equal(roleLabel(undefined), "Visiteur");
  });
});
