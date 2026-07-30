import {defineConfig,devices} from "@playwright/test";import {existsSync,readdirSync} from "node:fs";import {homedir} from "node:os";import {join} from "node:path";

// Playwright pins a browser build number to its own version; a machine that
// carries a different build (a pre-provisioned image, a shared cache) fails
// with "Executable doesn't exist" even though a perfectly usable browser is
// installed. Rather than hard-code one path per machine, look for the newest
// build of each browser in the usual roots and hand Playwright its path.
const roots=[process.env.PLAYWRIGHT_BROWSERS_PATH,join(homedir(),".cache/ms-playwright"),"/root/.cache/ms-playwright"].filter(Boolean);
function findBrowser(prefix,...relativePaths){
  const builds=[];
  for(const root of roots){
    let entries=[];try{entries=readdirSync(root)}catch{continue}
    for(const entry of entries){
      if(!entry.startsWith(`${prefix}-`))continue;
      const build=Number.parseInt(entry.slice(prefix.length+1),10);
      for(const relative of relativePaths){
        const executable=join(root,entry,relative);
        if(existsSync(executable))builds.push({build:Number.isInteger(build)?build:0,executable});
      }
    }
  }
  return builds.sort((a,b)=>b.build-a.build)[0]?.executable;
}
const chromiumPath=findBrowser("chromium_headless_shell","chrome-linux/headless_shell")??findBrowser("chromium","chrome-linux/chrome","chrome-mac/Chromium.app/Contents/MacOS/Chromium");
const webkitPath=findBrowser("webkit","minibrowser-wpe/MiniBrowser","minibrowser-gtk/MiniBrowser","pw_run.sh");

// A browser that is simply not installed must not turn the whole suite red:
// the projects that can run, run, and the missing ones say so once, loudly.
const projects=[
  {name:"desktop",browser:chromiumPath,use:{...devices["Desktop Chrome"],launchOptions:{executablePath:chromiumPath}}},
  {name:"mobile",browser:chromiumPath,use:{...devices["iPhone 13"],browserName:"chromium",launchOptions:{executablePath:chromiumPath}}},
  {name:"ipad-webkit",browser:webkitPath,use:{...devices["iPad Pro 11"],browserName:"webkit",launchOptions:{executablePath:webkitPath}}},
].filter(({name,browser})=>{
  if(browser)return true;
  console.warn(`[playwright] projet « ${name} » ignoré : navigateur absent. Installez-le avec « npx playwright install ».`);
  return false;
}).map(({browser,...project})=>project);

export default defineConfig({testDir:"./e2e",fullyParallel:false,retries:0,reporter:"line",use:{baseURL:"http://127.0.0.1:4173",trace:"retain-on-failure"},webServer:{command:"python3 -m http.server 4173",url:"http://127.0.0.1:4173",reuseExistingServer:true},projects});
