import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("https://esm.sh/**", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `export function createClient() { return { auth: {
      getSession: () => new Promise(() => {}),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
    } }; }`,
  }));
  await page.goto("./#/");
});

test("un clic anonyme ouvre le dialogue sans dépendre de Supabase", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.locator("#profile-button").click();
  await expect(page.locator("#login-view")).toBeVisible();
  await expect(page.locator("#login-view")).toHaveJSProperty("open", true);
  await expect(page.locator("#login-email")).toBeFocused();
  expect(consoleErrors).toEqual([]);
});

test("annulation, Échap et réouverture restaurent le focus", async ({ page }) => {
  const profile = page.locator("#profile-button");
  await profile.click();
  await page.locator("#login-cancel").click();
  await expect(page.locator("#login-view")).not.toBeVisible();
  await expect(profile).toBeFocused();

  await profile.click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#login-view")).not.toBeVisible();
  await profile.click();
  await expect(page.locator("#login-view")).toHaveJSProperty("open", true);
});

test("un clic dans le formulaire ne ferme pas le dialogue", async ({ page }) => {
  await page.locator("#profile-button").click();
  await page.locator("#login-email").click();
  await expect(page.locator("#login-view")).toHaveJSProperty("open", true);
});

test("fallback sans showModal", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { value: undefined });
  });
  await page.reload();
  await page.locator("#profile-button").click();
  await expect(page.locator("#login-view")).toHaveAttribute("open", "");
  await expect(page.locator("#login-email")).toBeFocused();
});
