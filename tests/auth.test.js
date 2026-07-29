import test from "node:test";
import assert from "node:assert/strict";

import { sessionDisplayName } from "../src/ui/auth.js";

test("sessionDisplayName prefers the full name from user metadata", () => {
  const session = {
    user: {
      email: "organisateur@example.ci",
      user_metadata: { full_name: "  Awa Kouassi  ", name: "Ignored" },
    },
  };
  assert.equal(sessionDisplayName(session), "Awa Kouassi");
});

test("sessionDisplayName falls back to the email", () => {
  assert.equal(
    sessionDisplayName({ user: { email: "organisateur@example.ci", user_metadata: {} } }),
    "organisateur@example.ci"
  );
});

test("sessionDisplayName always returns a useful label", () => {
  assert.equal(sessionDisplayName(null), "Compte organisateur");
});
