import { appendFileSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  CANONICAL_DIRECTIONS,
  frameFor,
  validateSpriteForgeManifest,
} from "../src/index.ts";

const root = resolve(
  process.env.SPRITE_FORGE_OUTPUT ?? ".cache/sprite-forge/run-a",
);
const manifestPath = resolve(root, "fixture_manifest.json");
const manifest = validateSpriteForgeManifest(
  JSON.parse(readFileSync(manifestPath, "utf8")),
);

for (const frame of manifest.frames) {
  const path = resolve(root, frame.file);
  if (!statSync(path).isFile() || statSync(path).size <= 100) {
    throw new Error(`Generated frame is missing or empty: ${frame.file}`);
  }
}

const atlasPath = resolve(root, manifest.atlas.file);
if (!statSync(atlasPath).isFile() || statSync(atlasPath).size <= 100) {
  throw new Error(`Generated atlas is missing or empty: ${manifest.atlas.file}`);
}

for (const direction of CANONICAL_DIRECTIONS) {
  frameFor(manifest, "mannequin_idle", direction);
}
for (const direction of ["N", "E", "S", "W"] as const) {
  frameFor(manifest, "chair", direction);
}

const summary = {
  fixture: manifest.fixture,
  schemaVersion: manifest.schemaVersion,
  frames: manifest.frames.length,
  atlas: {
    file: manifest.atlas.file,
    width: manifest.atlas.width,
    height: manifest.atlas.height,
  },
  mannequinDirections: [...CANONICAL_DIRECTIONS],
};

process.stdout.write(JSON.stringify(summary) + "\n");

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath !== undefined && summaryPath.length > 0) {
  appendFileSync(
    summaryPath,
    [
      "### Sprite Forge → renderer contract",
      "",
      `- Fixture: \`${manifest.fixture}\``,
      `- Schema: \`${manifest.schemaVersion}\``,
      `- Frames: ${manifest.frames.length}`,
      `- Atlas: ${manifest.atlas.width}×${manifest.atlas.height}`,
      `- Mannequin directions: ${CANONICAL_DIRECTIONS.join(", ")}`,
      "",
    ].join("\n"),
  );
}
