import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(
  path.resolve(process.cwd(), ".playwright/node_modules/playwright"),
);

const clientUrl =
  process.env.HOBBO_CLIENT_URL ??
  "http://127.0.0.1:5173/?server=ws://127.0.0.1:3000/realtime";
const serverUrl = process.env.HOBBO_SERVER_URL ?? "http://127.0.0.1:3000";
const worldId = process.env.HOBBO_WORLD_ID ?? "integrated-neighborhood-v1";
const playerId = process.env.HOBBO_PLAYER_ID ?? "resident-alex";
const screenshotPath =
  process.env.BROWSER_PLAYTEST_SCREENSHOT ??
  ".cache/browser/neighborhood-browser.png";

if (!/^[A-Za-z0-9:_-]+$/.test(worldId)) {
  throw new Error("HOBBO_WORLD_ID contains unsupported characters");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function spatialState() {
  const response = await fetch(
    `${serverUrl}/api/worlds/${encodeURIComponent(worldId)}/persons/${encodeURIComponent(playerId)}/spatial`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(
      `Spatial endpoint failed: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()).state;
}

function advanceWorld(through) {
  return execFileSync(
    "pnpm",
    ["--filter", "@hobbo/server", "advance:world"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOBBO_WORLD_ID: worldId,
        HOBBO_THROUGH: String(through),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
}

function travelIntentCount() {
  return Number(
    execFileSync(
      "psql",
      [
        "-Atc",
        `SELECT count(*) FROM spatial_travel_intents WHERE world_id = '${worldId}';`,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
      },
    ).trim(),
  );
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage", "--use-gl=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") {
    pageErrors.push(`console: ${message.text()}`);
  }
});

try {
  await page.goto(clientUrl, { waitUntil: "domcontentloaded" });

  await page.waitForFunction(
    () => document.querySelector("#room-label")?.textContent === "room-flat-a",
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    () => {
      const world = document.querySelector("#world");
      return (
        world instanceof HTMLElement &&
        world.dataset.roomId === "room-flat-a" &&
        world.dataset.playerPosition === "2,2,0" &&
        world.dataset.renderedPersonIds?.includes("resident-alex")
      );
    },
    undefined,
    { timeout: 15_000 },
  );

  const initial = await page.evaluate(() => {
    const world = document.querySelector("#world");
    const status = document.querySelector("#status");
    const canvas = world?.querySelector("canvas");
    return {
      status: status?.textContent ?? "",
      roomId: world instanceof HTMLElement ? world.dataset.roomId : undefined,
      peopleCount:
        world instanceof HTMLElement ? world.dataset.peopleCount : undefined,
      rendered:
        world instanceof HTMLElement
          ? world.dataset.renderedPersonIds
          : undefined,
      playerPosition:
        world instanceof HTMLElement ? world.dataset.playerPosition : undefined,
      canvasWidth: canvas instanceof HTMLCanvasElement ? canvas.width : 0,
      canvasHeight: canvas instanceof HTMLCanvasElement ? canvas.height : 0,
    };
  });
  assert(initial.status.includes("atlas "), "Sprite Forge atlas did not load");
  assert(initial.roomId === "room-flat-a", "Initial browser room is not flat A");
  assert(initial.peopleCount === "1", "Unexpected initial room population");
  assert(
    initial.rendered?.includes(playerId),
    "Player was not rendered from authoritative room.state",
  );
  assert(
    initial.canvasWidth === 900 && initial.canvasHeight === 600,
    "Pixi canvas was not initialized at the expected size",
  );

  await page.click('button[aria-label="East"]');
  await page.waitForFunction(
    () =>
      document.querySelector("#world")?.getAttribute("data-player-position") ===
      "3,2,0",
    undefined,
    { timeout: 10_000 },
  );
  const afterMove = await spatialState();
  assert(
    afterMove.roomId === "room-flat-a" &&
      afterMove.x === 3 &&
      afterMove.y === 2 &&
      afterMove.z === 0,
    `Authoritative movement mismatch: ${JSON.stringify(afterMove)}`,
  );

  await page.selectOption("#travel-destination", "room-cafe");
  await page.click("#travel-button");
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent?.includes("travel planned"),
    undefined,
    { timeout: 10_000 },
  );

  const advanceOutput = advanceWorld(60);
  assert(
    advanceOutput.includes('"currentSimTime": "60"'),
    `Runtime did not advance through sim 60: ${advanceOutput}`,
  );

  await page.waitForFunction(
    () =>
      document.querySelector("#room-label")?.textContent === "room-cafe" &&
      document.querySelector("#world")?.getAttribute("data-room-id") ===
        "room-cafe" &&
      document.querySelector("#world")?.getAttribute("data-player-position") ===
        "20,0,0",
    undefined,
    { timeout: 15_000 },
  );

  const afterTravel = await spatialState();
  assert(
    afterTravel.roomId === "room-cafe" &&
      afterTravel.x === 20 &&
      afterTravel.y === 0 &&
      afterTravel.z === 0,
    `Authoritative travel mismatch: ${JSON.stringify(afterTravel)}`,
  );
  assert(
    travelIntentCount() === 1,
    "Browser travel created more than one durable travel intent",
  );

  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector("#room-label")?.textContent === "room-cafe" &&
      document.querySelector("#world")?.getAttribute("data-player-position") ===
        "20,0,0",
    undefined,
    { timeout: 15_000 },
  );
  assert(
    travelIntentCount() === 1,
    "Browser reload duplicated the durable travel request",
  );

  assert(
    pageErrors.length === 0,
    `Browser emitted errors: ${pageErrors.join(" | ")}`,
  );

  process.stdout.write(
    JSON.stringify(
      {
        worldId,
        playerId,
        initial,
        afterMove,
        afterTravel,
        travelIntentCount: travelIntentCount(),
        screenshotPath,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
