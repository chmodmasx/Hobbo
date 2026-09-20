import {
  Application,
  Assets,
  Rectangle,
  Sprite,
  Texture,
} from "pixi.js";
import {
  CANONICAL_DIRECTIONS,
  applyGroundAnchor,
  frameFor,
  projectIsometric,
  sortIsometricRenderables,
  validateSpriteForgeManifest,
  type LogicalPosition,
  type SpriteDirection,
  type SpriteForgeFrame,
  type SpriteForgeManifest,
} from "@hobbo/rendering";
import "./style.css";

const MANIFEST_URL = "/sprite-forge/fixture_manifest.json";
const ASSET_ROOT = "/sprite-forge/";
const GEOMETRY = {
  tileWidth: 96,
  tileHeight: 48,
  elevationHeight: 48,
  originX: 450,
  originY: 180,
} as const;

interface SceneSprite {
  readonly id: string;
  readonly position: LogicalPosition;
  readonly sprite: Sprite;
}

function requireElement<T extends HTMLElement>(
  selector: string,
): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing client element: ${selector}`);
  }
  return element;
}

async function loadManifest(): Promise<SpriteForgeManifest> {
  const response = await fetch(MANIFEST_URL, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      `Sprite Forge manifest request failed: ${response.status} ${response.statusText}`,
    );
  }
  return validateSpriteForgeManifest(await response.json());
}

function subTexture(
  atlas: Texture,
  frame: SpriteForgeFrame,
): Texture {
  return new Texture({
    source: atlas.source,
    frame: new Rectangle(
      frame.atlas.x,
      frame.atlas.y,
      frame.atlas.width,
      frame.atlas.height,
    ),
  });
}

function placeSprite(
  sprite: Sprite,
  frame: SpriteForgeFrame,
  position: LogicalPosition,
): void {
  const ground = projectIsometric(position, GEOMETRY);
  const topLeft = applyGroundAnchor(ground, frame);
  sprite.position.set(topLeft.x, topLeft.y);
}

async function main(): Promise<void> {
  const status = requireElement<HTMLSpanElement>("#status");
  const directionLabel =
    requireElement<HTMLElement>("#direction-label");
  const rotateButton =
    requireElement<HTMLButtonElement>("#next-direction");
  const worldHost = requireElement<HTMLElement>("#world");

  const app = new Application();
  await app.init({
    width: 900,
    height: 600,
    backgroundColor: 0x171d25,
    antialias: false,
    resolution: 1,
  });
  worldHost.appendChild(app.canvas);

  const manifest = await loadManifest();
  const atlas = await Assets.load<Texture>(
    ASSET_ROOT + manifest.atlas.file,
  );
  atlas.source.scaleMode = "nearest";

  const mannequinFrames = new Map<
    SpriteDirection,
    { readonly frame: SpriteForgeFrame; readonly texture: Texture }
  >(
    CANONICAL_DIRECTIONS.map((direction) => {
      const frame = frameFor(
        manifest,
        "mannequin_idle",
        direction,
      );
      return [
        direction,
        {
          frame,
          texture: subTexture(atlas, frame),
        },
      ];
    }),
  );

  const chairFrame = frameFor(manifest, "chair", "E");
  const mannequinInitial = mannequinFrames.get("N");
  if (mannequinInitial === undefined) {
    throw new Error("Generated mannequin N frame disappeared");
  }

  const mannequinPosition: LogicalPosition = {
    x: 1,
    y: 1,
    z: 0,
  };
  const chairPosition: LogicalPosition = {
    x: 2,
    y: 1,
    z: 0,
  };

  const mannequinSprite = new Sprite(mannequinInitial.texture);
  placeSprite(
    mannequinSprite,
    mannequinInitial.frame,
    mannequinPosition,
  );

  const chairSprite = new Sprite(subTexture(atlas, chairFrame));
  placeSprite(chairSprite, chairFrame, chairPosition);

  const scene: readonly SceneSprite[] = [
    {
      id: "fixture-chair",
      position: chairPosition,
      sprite: chairSprite,
    },
    {
      id: "fixture-mannequin",
      position: mannequinPosition,
      sprite: mannequinSprite,
    },
  ];

  for (const entry of sortIsometricRenderables(scene)) {
    app.stage.addChild(entry.sprite);
  }

  let directionIndex = 0;
  directionLabel.textContent = CANONICAL_DIRECTIONS[directionIndex];

  rotateButton.addEventListener("click", () => {
    directionIndex =
      (directionIndex + 1) % CANONICAL_DIRECTIONS.length;
    const direction = CANONICAL_DIRECTIONS[directionIndex];
    if (direction === undefined) return;

    const next = mannequinFrames.get(direction);
    if (next === undefined) {
      throw new Error(
        `Generated mannequin frame disappeared: ${direction}`,
      );
    }
    mannequinSprite.texture = next.texture;
    placeSprite(mannequinSprite, next.frame, mannequinPosition);
    directionLabel.textContent = direction;
  });

  status.textContent =
    `${manifest.fixture} · ${manifest.frames.length} frames · ${manifest.atlas.width}×${manifest.atlas.height} atlas`;
}

void main().catch((error: unknown) => {
  const status = document.querySelector<HTMLElement>("#status");
  if (status !== null) {
    status.textContent =
      error instanceof Error ? error.message : String(error);
  }
  throw error;
});
