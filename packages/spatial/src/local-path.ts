import type { RoomBounds } from "./index.ts";

export interface SpatialTile {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function tileKey(tile: Pick<SpatialTile, "x" | "y">): string {
  return `${tile.x},${tile.y}`;
}

function assertTile(tile: SpatialTile, label: string): void {
  for (const [axis, value] of Object.entries(tile)) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${label}.${axis} must be a safe integer`);
    }
  }
}

function inside(bounds: RoomBounds, tile: SpatialTile): boolean {
  return (
    tile.z === bounds.z &&
    tile.x >= bounds.minX &&
    tile.x <= bounds.maxX &&
    tile.y >= bounds.minY &&
    tile.y <= bounds.maxY
  );
}

export function findLocalTilePath(
  bounds: RoomBounds,
  start: SpatialTile,
  destination: SpatialTile,
  blockedTiles: readonly SpatialTile[] = [],
): readonly SpatialTile[] | undefined {
  assertTile(start, "start");
  assertTile(destination, "destination");
  if (!inside(bounds, start)) {
    throw new RangeError("Local path start lies outside room bounds");
  }
  if (!inside(bounds, destination)) {
    throw new RangeError("Local path destination lies outside room bounds");
  }

  const blocked = new Set<string>();
  for (const tile of blockedTiles) {
    assertTile(tile, "blocked tile");
    if (tile.z !== bounds.z) continue;
    blocked.add(tileKey(tile));
  }
  if (blocked.has(tileKey(start)) || blocked.has(tileKey(destination))) {
    return undefined;
  }
  if (
    start.x === destination.x &&
    start.y === destination.y &&
    start.z === destination.z
  ) {
    return [{ ...start }];
  }

  const queue: SpatialTile[] = [{ ...start }];
  const visited = new Set<string>([tileKey(start)]);
  const previous = new Map<string, SpatialTile>();
  const deltas = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ] as const;

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;

    for (const [dx, dy] of deltas) {
      const next: SpatialTile = {
        x: current.x + dx,
        y: current.y + dy,
        z: bounds.z,
      };
      if (!inside(bounds, next)) continue;
      const key = tileKey(next);
      if (blocked.has(key) || visited.has(key)) continue;

      visited.add(key);
      previous.set(key, current);

      if (next.x === destination.x && next.y === destination.y) {
        const path: SpatialTile[] = [next];
        let cursor = current;
        while (
          cursor.x !== start.x ||
          cursor.y !== start.y ||
          cursor.z !== start.z
        ) {
          path.push(cursor);
          const prior = previous.get(tileKey(cursor));
          if (prior === undefined) {
            throw new RangeError("Local path predecessor chain is inconsistent");
          }
          cursor = prior;
        }
        path.push({ ...start });
        path.reverse();
        return path;
      }

      queue.push(next);
    }
  }

  return undefined;
}
