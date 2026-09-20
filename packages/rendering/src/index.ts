export const CANONICAL_DIRECTIONS = [
  "N",
  "NE",
  "E",
  "SE",
  "S",
  "SW",
  "W",
  "NW",
] as const;

export type SpriteDirection = (typeof CANONICAL_DIRECTIONS)[number];

export interface LogicalPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface IsometricGeometry {
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly elevationHeight: number;
  readonly originX?: number;
  readonly originY?: number;
}

export interface SpriteForgeAtlasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SpriteForgeFrame {
  readonly assetId: string;
  readonly direction: SpriteDirection;
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly anchor: readonly [number, number];
  readonly atlas: SpriteForgeAtlasRect;
}

export interface SpriteForgeManifest {
  readonly schemaVersion: number;
  readonly fixture: string;
  readonly blenderVersion: string;
  readonly render: {
    readonly engine: string;
    readonly width: number;
    readonly height: number;
    readonly transparent: boolean;
    readonly colorManagement: string;
  };
  readonly directions: readonly SpriteDirection[];
  readonly assets: Readonly<Record<string, unknown>>;
  readonly atlas: SpriteForgeAtlasRect & {
    readonly file: string;
    readonly columns: number;
    readonly rows: number;
  };
  readonly frames: readonly SpriteForgeFrame[];
}

export interface IsometricRenderable {
  readonly id: string;
  readonly position: LogicalPosition;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return number;
}

function direction(value: unknown, label: string): SpriteDirection {
  if (
    typeof value !== "string" ||
    !CANONICAL_DIRECTIONS.includes(value as SpriteDirection)
  ) {
    throw new TypeError(
      `${label} must be one of ${CANONICAL_DIRECTIONS.join(", ")}`,
    );
  }
  return value as SpriteDirection;
}

function atlasRect(
  value: unknown,
  label: string,
): SpriteForgeAtlasRect {
  const source = record(value, label);
  return {
    x: nonNegativeInteger(source.x, `${label}.x`),
    y: nonNegativeInteger(source.y, `${label}.y`),
    width: positiveInteger(source.width, `${label}.width`),
    height: positiveInteger(source.height, `${label}.height`),
  };
}

function frame(
  value: unknown,
  index: number,
  atlasWidth: number,
  atlasHeight: number,
): SpriteForgeFrame {
  const label = `frames[${index}]`;
  const source = record(value, label);
  const width = positiveInteger(source.width, `${label}.width`);
  const height = positiveInteger(source.height, `${label}.height`);
  const anchorValue = source.anchor;
  if (
    !Array.isArray(anchorValue) ||
    anchorValue.length !== 2
  ) {
    throw new TypeError(`${label}.anchor must contain exactly two integers`);
  }
  const anchorX = nonNegativeInteger(anchorValue[0], `${label}.anchor[0]`);
  const anchorY = nonNegativeInteger(anchorValue[1], `${label}.anchor[1]`);
  if (anchorX >= width || anchorY >= height) {
    throw new RangeError(`${label}.anchor must lie inside the frame`);
  }

  const atlas = atlasRect(source.atlas, `${label}.atlas`);
  if (
    atlas.x + atlas.width > atlasWidth ||
    atlas.y + atlas.height > atlasHeight
  ) {
    throw new RangeError(`${label}.atlas lies outside the atlas`);
  }
  if (atlas.width !== width || atlas.height !== height) {
    throw new RangeError(
      `${label}.atlas dimensions must match frame dimensions`,
    );
  }

  return {
    assetId: nonBlankString(source.assetId, `${label}.assetId`),
    direction: direction(source.direction, `${label}.direction`),
    file: nonBlankString(source.file, `${label}.file`),
    width,
    height,
    anchor: [anchorX, anchorY],
    atlas,
  };
}

function canonicalDirectionList(value: unknown): readonly SpriteDirection[] {
  if (!Array.isArray(value)) {
    throw new TypeError("directions must be an array");
  }
  const directions = value.map((entry, index) =>
    direction(entry, `directions[${index}]`),
  );
  if (new Set(directions).size !== directions.length) {
    throw new RangeError("directions cannot contain duplicates");
  }
  if (
    directions.length !== CANONICAL_DIRECTIONS.length ||
    CANONICAL_DIRECTIONS.some(
      (expected, index) => directions[index] !== expected,
    )
  ) {
    throw new RangeError(
      "directions must contain the canonical eight directions in order",
    );
  }
  return directions;
}

export function validateSpriteForgeManifest(
  value: unknown,
): SpriteForgeManifest {
  const source = record(value, "manifest");
  const schemaVersion = positiveInteger(
    source.schemaVersion,
    "schemaVersion",
  );
  if (schemaVersion !== 1) {
    throw new RangeError(
      `Unsupported Sprite Forge schemaVersion ${schemaVersion}`,
    );
  }

  const renderSource = record(source.render, "render");
  if (typeof renderSource.transparent !== "boolean") {
    throw new TypeError("render.transparent must be boolean");
  }
  const render = {
    engine: nonBlankString(renderSource.engine, "render.engine"),
    width: positiveInteger(renderSource.width, "render.width"),
    height: positiveInteger(renderSource.height, "render.height"),
    transparent: renderSource.transparent,
    colorManagement: nonBlankString(
      renderSource.colorManagement,
      "render.colorManagement",
    ),
  };

  const atlasSource = record(source.atlas, "atlas");
  const atlas = {
    x: 0,
    y: 0,
    width: positiveInteger(atlasSource.width, "atlas.width"),
    height: positiveInteger(atlasSource.height, "atlas.height"),
    file: nonBlankString(atlasSource.file, "atlas.file"),
    columns: positiveInteger(atlasSource.columns, "atlas.columns"),
    rows: positiveInteger(atlasSource.rows, "atlas.rows"),
  };

  const frameValues = source.frames;
  if (!Array.isArray(frameValues) || frameValues.length === 0) {
    throw new TypeError("frames must be a non-empty array");
  }
  const frames = frameValues.map((entry, index) =>
    frame(entry, index, atlas.width, atlas.height),
  );
  const identities = new Set<string>();
  for (const item of frames) {
    const key = `${item.assetId}\u0000${item.direction}`;
    if (identities.has(key)) {
      throw new RangeError(
        `Duplicate Sprite Forge frame ${item.assetId}/${item.direction}`,
      );
    }
    identities.add(key);
  }

  return {
    schemaVersion,
    fixture: nonBlankString(source.fixture, "fixture"),
    blenderVersion: nonBlankString(
      source.blenderVersion,
      "blenderVersion",
    ),
    render,
    directions: canonicalDirectionList(source.directions),
    assets: record(source.assets, "assets"),
    atlas,
    frames,
  };
}

function finiteCoordinate(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
  return value;
}

export function projectIsometric(
  position: LogicalPosition,
  geometry: IsometricGeometry,
): ScreenPoint {
  const x = finiteCoordinate(position.x, "position.x");
  const y = finiteCoordinate(position.y, "position.y");
  const z = finiteCoordinate(position.z, "position.z");
  const tileWidth = finiteCoordinate(
    geometry.tileWidth,
    "geometry.tileWidth",
  );
  const tileHeight = finiteCoordinate(
    geometry.tileHeight,
    "geometry.tileHeight",
  );
  const elevationHeight = finiteCoordinate(
    geometry.elevationHeight,
    "geometry.elevationHeight",
  );
  if (tileWidth <= 0 || tileHeight <= 0 || elevationHeight < 0) {
    throw new RangeError(
      "isometric geometry requires positive tile dimensions and non-negative elevation",
    );
  }
  const originX = finiteCoordinate(
    geometry.originX ?? 0,
    "geometry.originX",
  );
  const originY = finiteCoordinate(
    geometry.originY ?? 0,
    "geometry.originY",
  );

  return {
    x: originX + (x - y) * (tileWidth / 2),
    y:
      originY +
      (x + y) * (tileHeight / 2) -
      z * elevationHeight,
  };
}

export function applyGroundAnchor(
  groundPoint: ScreenPoint,
  frame: Pick<SpriteForgeFrame, "anchor">,
): ScreenPoint {
  return {
    x: groundPoint.x - frame.anchor[0],
    y: groundPoint.y - frame.anchor[1],
  };
}

export function frameFor(
  manifest: SpriteForgeManifest,
  assetId: string,
  directionValue: SpriteDirection,
): SpriteForgeFrame {
  const match = manifest.frames.find(
    (candidate) =>
      candidate.assetId === assetId &&
      candidate.direction === directionValue,
  );
  if (match === undefined) {
    throw new RangeError(
      `Sprite Forge frame missing: ${assetId}/${directionValue}`,
    );
  }
  return match;
}

function compareNumbers(left: number, right: number): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareIsometricDepth(
  left: IsometricRenderable,
  right: IsometricRenderable,
): number {
  const leftBand = left.position.x + left.position.y;
  const rightBand = right.position.x + right.position.y;
  return (
    compareNumbers(leftBand, rightBand) ||
    compareNumbers(left.position.z, right.position.z) ||
    compareNumbers(left.position.y, right.position.y) ||
    compareNumbers(left.position.x, right.position.x) ||
    left.id.localeCompare(right.id)
  );
}

export function sortIsometricRenderables<T extends IsometricRenderable>(
  values: readonly T[],
): readonly T[] {
  return [...values].sort(compareIsometricDepth);
}
