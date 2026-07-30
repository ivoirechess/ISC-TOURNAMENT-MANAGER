// Arrival through the e-mail link of an invitation (or of a password reset).
//
// The double in mock-supabase.js reproduces the real client: Supabase uses
// the implicit flow, so the tokens land in the URL *fragment*, and the client
// reads that fragment as a query string. These tests pin both the shape of
// the URL and what the site must do with it.
import {test,expect} from "@playwright/test";import {readFileSync} from "node:fs";
const mock=readFileSync(new URL("./mock-supabase.js",import.meta.url),"utf8");
test.beforeEach(async({page})=>page.route("https://esm.sh/**",route=>route.fulfill({contentType:"text/javascript",body:mock})));

// Exactly what GoTrue builds: `redirectTo + "#" + params`, params sorted by
// url.Values.Encode(). See supabase/auth, tokens.AsRedirectURL.
const tokens="access_token=jeton-invitation&expires_at=9999999999&expires_in=3600&refresh_token=jeton-rafraichissement&sb=&token_type=bearer";
const inviteHash=`#${tokens}&type=invite`;
const recoveryHash=`#${tokens}&type=recovery`;
// A redirect URL that already carried a route produced two fragments; those
// invitations are still in people's inboxes, so they must keep working.
const legacyInviteHash=`#/administration/utilisateurs#${tokens}&type=invite`;
const expiredHash="#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";

const heading=page=>page.getByRole("heading",{name:"Définir votre mot de passe"});
async function setPassword(page,password,confirmation=password){
  await page.locator("#password-setup-new").fill(password);
  await page.locator("#password-setup-confirm").fill(confirmation);
  await page.locator("#password-setup-form").evaluate(form=>form.requestSubmit());
}

test("le lien d'invitation impose l'écran de mot de passe",async({page})=>{
  await page.goto(`/${inviteHash}`);
  await expect(page.locator("#startup-error")).toBeHidden();
  await expect(heading(page)).toBeVisible();
  // Blocking: the rest of the site is gone, and the tokens have left the URL.
  await expect(page.locator("#view-home")).toBeHidden();
  await expect(page.locator("header .main-nav")).toBeHidden();
  expect(await page.evaluate(()=>location.hash)).toBe("#/definir-mot-de-passe");
  expect(await page.evaluate(()=>location.href)).not.toContain("jeton-invitation");
});

test("la navigation reste bloquée tant que le mot de passe n'est pas défini",async({page})=>{
  await page.goto(`/${inviteHash}`);
  await expect(heading(page)).toBeVisible();
  for(const target of ["#/","#/joueurs","#/administration/utilisateurs","#/nouveau-tournoi"]){
    await page.evaluate(hash=>{location.hash=hash},target);
    await expect(heading(page)).toBeVisible();
    await expect(page.locator("#view-players")).toBeHidden();
    await expect(page.locator("#view-user-administration")).toBeHidden();
  }
  // A reload must not be a way round it either.
  await page.reload();
  await expect(heading(page)).toBeVisible();
});

test("le formulaire refuse un mot de passe trop court ou mal confirmé",async({page})=>{
  await page.goto(`/${inviteHash}`);
  await expect(heading(page)).toBeVisible();
  await setPassword(page,"court");
  await expect(page.locator("#password-setup-error")).toContainText("12 caractères");
  await setPassword(page,"Tournoi2026!Abidjan","Tournoi2026!Bouake");
  await expect(page.locator("#password-setup-error")).toContainText("ne correspondent pas");
  await expect(heading(page)).toBeVisible();
});

test("mot de passe défini, puis reconnexion avec ce mot de passe",async({page})=>{
  await page.goto(`/${inviteHash}`);
  await expect(heading(page)).toBeVisible();
  await setPassword(page,"Tournoi2026!Abidjan");

  // Landing screen: an invited organizer arrives on the home page, where
  // their own tournaments and the "create" action are. The users
  // administration is super-admin only and would bounce them straight back.
  await expect(page.locator("#view-password-setup")).toBeHidden();
  await expect.poll(()=>page.evaluate(()=>location.hash)).toBe("#/");
  await expect(page.locator("body")).toHaveClass(/is-admin/);
  await expect(page.locator("header .main-nav")).toBeVisible();
  await expect(page.getByRole("link",{name:"Créer un tournoi"})).toBeVisible();

  // Sign out, then sign back in the ordinary way with the new password.
  await page.locator("#profile-button").click();
  await page.locator("#logout-button").click();
  await expect(page.locator("body")).not.toHaveClass(/is-admin/);
  await page.locator("#profile-button").click();
  await expect(page.locator("#login-button")).toBeVisible();
  await page.locator("#login-button").click();
  await page.locator("#login-email").fill("organisateur@example.ci");
  await page.locator("#login-password").fill("Tournoi2026!Abidjan");
  await page.locator("#login-form").evaluate(form=>form.requestSubmit());
  await expect(page.locator("body")).toHaveClass(/is-admin/);
  await expect(page.locator("#auth-name")).toContainText("organisateur@example.ci");
});

test("une invitation à deux fragments reste exploitable",async({page})=>{
  await page.goto(`/${legacyInviteHash}`);
  await expect(page.locator("#startup-error")).toBeHidden();
  await expect(heading(page)).toBeVisible();
  await setPassword(page,"Tournoi2026!Abidjan");
  await expect.poll(()=>page.evaluate(()=>location.hash)).toBe("#/");
});

test("un super-admin invité revient à l'administration des utilisateurs",async({page})=>{
  await page.addInitScript(()=>localStorage.setItem("mock-role","super_admin"));
  await page.goto(`/${inviteHash}`);
  await expect(heading(page)).toBeVisible();
  await setPassword(page,"Tournoi2026!Abidjan");
  await expect.poll(()=>page.evaluate(()=>location.hash)).toBe("#/administration/utilisateurs");
  await expect(page.getByRole("heading",{name:"Administration des utilisateurs"})).toBeVisible();
});

test("un lien de réinitialisation ouvre le même écran",async({page})=>{
  await page.goto(`/${recoveryHash}`);
  await expect(heading(page)).toBeVisible();
  await expect(page.locator("#password-setup-intro")).toContainText("réinitialisation");
});

test("un lien expiré ou déjà utilisé est expliqué, pas ignoré",async({page})=>{
  await page.goto(`/${expiredHash}`);
  await expect(page.locator("#startup-error")).toBeHidden();
  await expect(page.getByRole("heading",{name:"Lien expiré ou déjà utilisé"})).toBeVisible();
  await expect(page.locator("#password-setup-error")).toContainText("super-administrateur");
  await expect(page.locator("#password-setup-form")).toBeHidden();
  // A dead link must not leave a usable session behind.
  await expect(page.locator("body")).not.toHaveClass(/is-admin/);
});

test("un lien dont la session ne s'établit pas le dit clairement",async({page})=>{
  await page.goto(`/#access_token=jeton-inconnu&refresh_token=x&token_type=bearer&type=invite`);
  await expect(page.getByRole("heading",{name:"Lien expiré ou déjà utilisé"})).toBeVisible();
  await expect(page.locator("#password-setup-form")).toBeHidden();
});

test("l'écran n'est pas atteignable sans lien",async({page})=>{
  await page.goto("/#/definir-mot-de-passe");
  await expect.poll(()=>page.evaluate(()=>location.hash)).toBe("#/");
  await expect(page.locator("#view-password-setup")).toBeHidden();
});

test("ni le mot de passe ni les jetons ne partent dans la console",async({page})=>{
  const output=[];
  page.on("console",message=>output.push(message.text()));
  page.on("pageerror",error=>output.push(String(error?.stack??error)));
  await page.goto(`/${inviteHash}`);
  await expect(heading(page)).toBeVisible();
  await setPassword(page,"court");
  await expect(page.locator("#password-setup-error")).toBeVisible();
  await setPassword(page,"Tournoi2026!Abidjan");
  await expect(page.locator("#view-password-setup")).toBeHidden();
  const leaked=output.filter(line=>line.includes("Tournoi2026!Abidjan")||line.includes("court")||line.includes("jeton-invitation")||line.includes("jeton-rafraichissement"));
  expect(leaked).toEqual([]);
});
