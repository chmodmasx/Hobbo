export const SPATIAL_NODE_KINDS = ["room", "building", "street"] as const;

export type SpatialNodeKind = (typeof SPATIAL_NODE_KINDS)[number];

export interface SpatialTopologyNode {
  readonly id: string;
  readonly kind: SpatialNodeKind;
  readonly parentId?: string;
}

export interface SpatialTopologyConnection {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly travelSeconds: number;
  readonly bidirectional?: boolean;
  readonly enabled?: boolean;
}

export interface SpatialRoute {
  readonly nodeIds: readonly string[];
  readonly connectionIds: readonly string[];
  readonly totalTravelSeconds: number;
}

interface RouteState extends SpatialRoute {
  readonly nodeId: string;
  readonly key: string;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new RangeError(`${label} cannot be blank`);
  }
  return normalized;
}

function positiveTravelSeconds(value: number, connectionId: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `Connection ${connectionId} travelSeconds must be a positive safe integer`,
    );
  }
  return value;
}

function routeKey(
  connectionIds: readonly string[],
  nodeIds: readonly string[],
): string {
  return `${connectionIds.join("\u0000")}\u0001${nodeIds.join("\u0000")}`;
}

function compareState(left: RouteState, right: RouteState): number {
  return (
    left.totalTravelSeconds - right.totalTravelSeconds ||
    left.key.localeCompare(right.key) ||
    left.nodeId.localeCompare(right.nodeId)
  );
}

export function validateSpatialTopology(
  nodes: readonly SpatialTopologyNode[],
  connections: readonly SpatialTopologyConnection[],
): void {
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    const id = nonBlank(node.id, "Spatial node id");
    if (nodeIds.has(id)) {
      throw new RangeError(`Duplicate spatial node id: ${id}`);
    }
    nodeIds.add(id);
    if (!SPATIAL_NODE_KINDS.includes(node.kind)) {
      throw new RangeError(`Unsupported spatial node kind: ${String(node.kind)}`);
    }
    if (node.parentId !== undefined) {
      nonBlank(node.parentId, `Spatial node ${id} parentId`);
    }
  }

  for (const node of nodes) {
    if (node.parentId !== undefined && !nodeIds.has(node.parentId)) {
      throw new RangeError(
        `Spatial node ${node.id} references missing parent ${node.parentId}`,
      );
    }
    if (node.parentId === node.id) {
      throw new RangeError(`Spatial node ${node.id} cannot parent itself`);
    }
  }

  const connectionIds = new Set<string>();
  for (const connection of connections) {
    const id = nonBlank(connection.id, "Spatial connection id");
    if (connectionIds.has(id)) {
      throw new RangeError(`Duplicate spatial connection id: ${id}`);
    }
    connectionIds.add(id);
    nonBlank(connection.fromNodeId, `Connection ${id} fromNodeId`);
    nonBlank(connection.toNodeId, `Connection ${id} toNodeId`);
    positiveTravelSeconds(connection.travelSeconds, id);
    if (!nodeIds.has(connection.fromNodeId)) {
      throw new RangeError(
        `Connection ${id} references missing from node ${connection.fromNodeId}`,
      );
    }
    if (!nodeIds.has(connection.toNodeId)) {
      throw new RangeError(
        `Connection ${id} references missing to node ${connection.toNodeId}`,
      );
    }
    if (connection.fromNodeId === connection.toNodeId) {
      throw new RangeError(`Connection ${id} cannot connect a node to itself`);
    }
  }
}

export function findShortestSpatialRoute(
  nodes: readonly SpatialTopologyNode[],
  connections: readonly SpatialTopologyConnection[],
  startNodeId: string,
  destinationNodeId: string,
): SpatialRoute | undefined {
  validateSpatialTopology(nodes, connections);
  nonBlank(startNodeId, "startNodeId");
  nonBlank(destinationNodeId, "destinationNodeId");

  const nodeIds = new Set(nodes.map((node) => node.id));
  if (!nodeIds.has(startNodeId)) {
    throw new RangeError(`Unknown route start node: ${startNodeId}`);
  }
  if (!nodeIds.has(destinationNodeId)) {
    throw new RangeError(`Unknown route destination node: ${destinationNodeId}`);
  }
  if (startNodeId === destinationNodeId) {
    return {
      nodeIds: [startNodeId],
      connectionIds: [],
      totalTravelSeconds: 0,
    };
  }

  const adjacency = new Map<
    string,
    Array<{
      readonly nodeId: string;
      readonly connectionId: string;
      readonly travelSeconds: number;
    }>
  >();

  function addEdge(
    from: string,
    to: string,
    connectionId: string,
    travelSeconds: number,
  ): void {
    let edges = adjacency.get(from);
    if (edges === undefined) {
      edges = [];
      adjacency.set(from, edges);
    }
    edges.push({ nodeId: to, connectionId, travelSeconds });
  }

  for (const connection of connections) {
    if (connection.enabled === false) continue;
    addEdge(
      connection.fromNodeId,
      connection.toNodeId,
      connection.id,
      connection.travelSeconds,
    );
    if (connection.bidirectional === true) {
      addEdge(
        connection.toNodeId,
        connection.fromNodeId,
        connection.id,
        connection.travelSeconds,
      );
    }
  }

  for (const edges of adjacency.values()) {
    edges.sort(
      (left, right) =>
        left.connectionId.localeCompare(right.connectionId) ||
        left.nodeId.localeCompare(right.nodeId),
    );
  }

  const initial: RouteState = {
    nodeId: startNodeId,
    nodeIds: [startNodeId],
    connectionIds: [],
    totalTravelSeconds: 0,
    key: routeKey([], [startNodeId]),
  };
  const frontier: RouteState[] = [initial];
  const best = new Map<string, { readonly cost: number; readonly key: string }>([
    [startNodeId, { cost: 0, key: initial.key }],
  ]);

  while (frontier.length > 0) {
    frontier.sort(compareState);
    const current = frontier.shift();
    if (current === undefined) break;

    const known = best.get(current.nodeId);
    if (
      known === undefined ||
      known.cost !== current.totalTravelSeconds ||
      known.key !== current.key
    ) {
      continue;
    }

    if (current.nodeId === destinationNodeId) {
      return {
        nodeIds: current.nodeIds,
        connectionIds: current.connectionIds,
        totalTravelSeconds: current.totalTravelSeconds,
      };
    }

    for (const edge of adjacency.get(current.nodeId) ?? []) {
      const nodeIds = [...current.nodeIds, edge.nodeId];
      const connectionIds = [...current.connectionIds, edge.connectionId];
      const totalTravelSeconds =
        current.totalTravelSeconds + edge.travelSeconds;
      if (!Number.isSafeInteger(totalTravelSeconds)) {
        throw new RangeError("Spatial route travel time exceeded safe integer range");
      }
      const key = routeKey(connectionIds, nodeIds);
      const previous = best.get(edge.nodeId);
      if (
        previous !== undefined &&
        (previous.cost < totalTravelSeconds ||
          (previous.cost === totalTravelSeconds &&
            previous.key.localeCompare(key) <= 0))
      ) {
        continue;
      }

      best.set(edge.nodeId, { cost: totalTravelSeconds, key });
      frontier.push({
        nodeId: edge.nodeId,
        nodeIds,
        connectionIds,
        totalTravelSeconds,
        key,
      });
    }
  }

  return undefined;
}
