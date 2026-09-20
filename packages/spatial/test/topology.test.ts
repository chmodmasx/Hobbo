import { describe, expect, it } from "vitest";
import {
  findShortestSpatialRoute,
  type SpatialTopologyConnection,
  type SpatialTopologyNode,
} from "../src/topology.ts";

const nodes: readonly SpatialTopologyNode[] = [
  { id: "room-home", kind: "room", parentId: "building-home" },
  { id: "building-home", kind: "building" },
  { id: "street-main", kind: "street" },
  { id: "building-work", kind: "building" },
  { id: "room-work", kind: "room", parentId: "building-work" },
];

const connections: readonly SpatialTopologyConnection[] = [
  {
    id: "home-door",
    fromNodeId: "room-home",
    toNodeId: "building-home",
    travelSeconds: 5,
    bidirectional: true,
  },
  {
    id: "home-street",
    fromNodeId: "building-home",
    toNodeId: "street-main",
    travelSeconds: 20,
    bidirectional: true,
  },
  {
    id: "street-work",
    fromNodeId: "street-main",
    toNodeId: "building-work",
    travelSeconds: 30,
    bidirectional: true,
  },
  {
    id: "work-door",
    fromNodeId: "building-work",
    toNodeId: "room-work",
    travelSeconds: 5,
    bidirectional: true,
  },
];

describe("hierarchical spatial topology", () => {
  it("finds a deterministic room-to-room route through buildings and street", () => {
    expect(
      findShortestSpatialRoute(nodes, connections, "room-home", "room-work"),
    ).toEqual({
      nodeIds: [
        "room-home",
        "building-home",
        "street-main",
        "building-work",
        "room-work",
      ],
      connectionIds: [
        "home-door",
        "home-street",
        "street-work",
        "work-door",
      ],
      totalTravelSeconds: 60,
    });
  });

  it("uses deterministic connection identity as the tie-break for equal cost", () => {
    const tiedNodes: readonly SpatialTopologyNode[] = [
      { id: "a", kind: "room" },
      { id: "b", kind: "street" },
      { id: "c", kind: "street" },
      { id: "d", kind: "room" },
    ];
    const tiedConnections: readonly SpatialTopologyConnection[] = [
      { id: "z-a-c", fromNodeId: "a", toNodeId: "c", travelSeconds: 5 },
      { id: "z-c-d", fromNodeId: "c", toNodeId: "d", travelSeconds: 5 },
      { id: "a-a-b", fromNodeId: "a", toNodeId: "b", travelSeconds: 5 },
      { id: "a-b-d", fromNodeId: "b", toNodeId: "d", travelSeconds: 5 },
    ];

    expect(findShortestSpatialRoute(tiedNodes, tiedConnections, "a", "d"))
      .toMatchObject({
        nodeIds: ["a", "b", "d"],
        connectionIds: ["a-a-b", "a-b-d"],
        totalTravelSeconds: 10,
      });
  });

  it("uses locale-independent code-unit ordering for route ties", () => {
    const tiedNodes: readonly SpatialTopologyNode[] = [
      { id: "start", kind: "room" },
      { id: "z-node", kind: "street" },
      { id: "umlaut-node", kind: "street" },
      { id: "finish", kind: "room" },
    ];
    const tiedConnections: readonly SpatialTopologyConnection[] = [
      {
        id: "ä-first",
        fromNodeId: "start",
        toNodeId: "umlaut-node",
        travelSeconds: 5,
      },
      {
        id: "ä-last",
        fromNodeId: "umlaut-node",
        toNodeId: "finish",
        travelSeconds: 5,
      },
      {
        id: "z-first",
        fromNodeId: "start",
        toNodeId: "z-node",
        travelSeconds: 5,
      },
      {
        id: "z-last",
        fromNodeId: "z-node",
        toNodeId: "finish",
        travelSeconds: 5,
      },
    ];

    expect(
      findShortestSpatialRoute(
        tiedNodes,
        tiedConnections,
        "start",
        "finish",
      ),
    ).toMatchObject({
      nodeIds: ["start", "z-node", "finish"],
      connectionIds: ["z-first", "z-last"],
      totalTravelSeconds: 10,
    });
  });

  it("returns undefined when disabled edges make a destination unreachable", () => {
    expect(
      findShortestSpatialRoute(
        nodes,
        connections.map((connection) =>
          connection.id === "street-work"
            ? { ...connection, enabled: false }
            : connection,
        ),
        "room-home",
        "room-work",
      ),
    ).toBeUndefined();
  });

  it("rejects malformed topology instead of silently routing through it", () => {
    expect(() =>
      findShortestSpatialRoute(
        nodes,
        [
          ...connections,
          {
            id: "broken",
            fromNodeId: "missing",
            toNodeId: "room-home",
            travelSeconds: 1,
          },
        ],
        "room-home",
        "room-work",
      ),
    ).toThrow(/missing from node/i);
  });
});
