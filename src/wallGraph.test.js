import { describe, it, expect } from "vitest";
import { mergeVertices, findClosedAreas, hasClosedBoundary } from "./wallGraph.js";

const sortIds = (ids) => [...ids].sort();

// ─── mergeVertices ──────────────────────────────────────────────────────────

describe("mergeVertices", () => {
  it("shares a vertex between walls whose endpoints coincide", () => {
    const walls = [
      { id: "a", a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
      { id: "b", a: { x: 5, y: 0 }, b: { x: 5, y: 5 } },
    ];
    const { vertices, edges } = mergeVertices(walls);
    expect(vertices).toHaveLength(3);
    expect(edges[0].b).toBe(edges[1].a);
  });

  it("snaps near-coincident points within tolerance", () => {
    const walls = [
      { id: "a", a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
      { id: "b", a: { x: 5.02, y: 0.01 }, b: { x: 5, y: 5 } },
    ];
    const { vertices, edges } = mergeVertices(walls, 0.05);
    expect(vertices).toHaveLength(3);
    expect(edges[0].b).toBe(edges[1].a);
  });
});

// ─── findClosedAreas ────────────────────────────────────────────────────────

describe("findClosedAreas", () => {
  it("returns nothing for an empty wall list", () => {
    expect(findClosedAreas([])).toEqual([]);
  });

  it("returns nothing for a single dangling wall", () => {
    const walls = [{ id: "1", a: { x: 0, y: 0 }, b: { x: 5, y: 0 } }];
    expect(findClosedAreas(walls)).toEqual([]);
  });

  it("returns nothing for an open polyline (not yet closed)", () => {
    const walls = [
      { id: "a", a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
      { id: "b", a: { x: 5, y: 0 }, b: { x: 5, y: 5 } },
      { id: "c", a: { x: 5, y: 5 }, b: { x: 0, y: 5 } },
    ];
    expect(findClosedAreas(walls)).toEqual([]);
  });

  it("finds a single closed rectangle", () => {
    const walls = [
      { id: "a", a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
      { id: "b", a: { x: 5, y: 0 }, b: { x: 5, y: 5 } },
      { id: "c", a: { x: 5, y: 5 }, b: { x: 0, y: 5 } },
      { id: "d", a: { x: 0, y: 5 }, b: { x: 0, y: 0 } },
    ];
    const faces = findClosedAreas(walls);
    expect(faces).toHaveLength(1);
    expect(sortIds(faces[0].wallIds)).toEqual(["a", "b", "c", "d"]);
  });

  it("finds an L-shaped (concave) room as a single face", () => {
    const walls = [
      { id: "a", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
      { id: "b", a: { x: 10, y: 0 }, b: { x: 10, y: 5 } },
      { id: "c", a: { x: 10, y: 5 }, b: { x: 5, y: 5 } },
      { id: "d", a: { x: 5, y: 5 }, b: { x: 5, y: 10 } },
      { id: "e", a: { x: 5, y: 10 }, b: { x: 0, y: 10 } },
      { id: "f", a: { x: 0, y: 10 }, b: { x: 0, y: 0 } },
    ];
    const faces = findClosedAreas(walls);
    expect(faces).toHaveLength(1);
    expect(sortIds(faces[0].wallIds)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("finds two separate rooms sharing an internal wall", () => {
    // Two 5.5m-deep rooms side by side, sharing the middle wall "c".
    const walls = [
      { id: "e", a: { x: 3, y: 0 }, b: { x: 8.5, y: 0 } },
      { id: "c", a: { x: 8.5, y: 0 }, b: { x: 8.5, y: 5.5 } },
      { id: "0", a: { x: 8.5, y: 5.5 }, b: { x: 3, y: 5.5 } },
      { id: "eff", a: { x: 3, y: 5.5 }, b: { x: 3, y: 0 } },
      { id: "515", a: { x: 8.5, y: 0 }, b: { x: 13, y: 0 } },
      { id: "3d1", a: { x: 13, y: 0 }, b: { x: 13, y: 5.5 } },
      { id: "ace", a: { x: 13, y: 5.5 }, b: { x: 8.5, y: 5.5 } },
    ];
    const faces = findClosedAreas(walls);
    expect(faces).toHaveLength(2);

    const left = faces.find((f) => f.wallIds.includes("eff"));
    const right = faces.find((f) => f.wallIds.includes("515"));
    expect(sortIds(left.wallIds)).toEqual(["0", "c", "e", "eff"]);
    expect(sortIds(right.wallIds)).toEqual(["3d1", "515", "ace", "c"]);

    // Both faces should share the dividing wall "c".
    expect(left.wallIds).toContain("c");
    expect(right.wallIds).toContain("c");
  });

  it("finds two disconnected rooms independently", () => {
    const walls = [
      { id: "1", a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
      { id: "2", a: { x: 5, y: 0 }, b: { x: 5, y: 5 } },
      { id: "3", a: { x: 5, y: 5 }, b: { x: 0, y: 5 } },
      { id: "4", a: { x: 0, y: 5 }, b: { x: 0, y: 0 } },
      { id: "5", a: { x: 10, y: 0 }, b: { x: 15, y: 0 } },
      { id: "6", a: { x: 15, y: 0 }, b: { x: 15, y: 5 } },
      { id: "7", a: { x: 15, y: 5 }, b: { x: 10, y: 5 } },
      { id: "8", a: { x: 10, y: 5 }, b: { x: 10, y: 0 } },
    ];
    const faces = findClosedAreas(walls);
    expect(faces).toHaveLength(2);
    expect(sortIds(faces[0].wallIds)).toEqual(["1", "2", "3", "4"]);
    expect(sortIds(faces[1].wallIds)).toEqual(["5", "6", "7", "8"]);
  });

  it("finds all four rooms in a 2x2 grid with shared walls", () => {
    const walls = [
      { id: "h1", a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
      { id: "h2", a: { x: 5, y: 0 }, b: { x: 10, y: 0 } },
      { id: "h3", a: { x: 0, y: 5 }, b: { x: 5, y: 5 } },
      { id: "h4", a: { x: 5, y: 5 }, b: { x: 10, y: 5 } },
      { id: "h5", a: { x: 0, y: 10 }, b: { x: 5, y: 10 } },
      { id: "h6", a: { x: 5, y: 10 }, b: { x: 10, y: 10 } },
      { id: "v1", a: { x: 0, y: 0 }, b: { x: 0, y: 5 } },
      { id: "v2", a: { x: 0, y: 5 }, b: { x: 0, y: 10 } },
      { id: "v3", a: { x: 5, y: 0 }, b: { x: 5, y: 5 } },
      { id: "v4", a: { x: 5, y: 5 }, b: { x: 5, y: 10 } },
      { id: "v5", a: { x: 10, y: 0 }, b: { x: 10, y: 5 } },
      { id: "v6", a: { x: 10, y: 5 }, b: { x: 10, y: 10 } },
    ];
    const faces = findClosedAreas(walls);
    expect(faces).toHaveLength(4);
    for (const face of faces) {
      expect(face.wallIds).toHaveLength(4);
    }
  });

  it("splits a room into two when a partition wall lands on the middle of opposite walls", () => {
    // 10x5 room split into two 5x5 rooms by a vertical partition wall "p"
    // whose endpoints sit mid-span on walls "a" and "c" (T-junctions).
    const walls = [
      { id: "a", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
      { id: "b", a: { x: 10, y: 0 }, b: { x: 10, y: 5 } },
      { id: "c", a: { x: 10, y: 5 }, b: { x: 0, y: 5 } },
      { id: "d", a: { x: 0, y: 5 }, b: { x: 0, y: 0 } },
      { id: "p", a: { x: 5, y: 0 }, b: { x: 5, y: 5 } },
    ];
    const faces = findClosedAreas(walls);
    expect(faces).toHaveLength(2);

    const left = faces.find((f) => f.wallIds.includes("d"));
    const right = faces.find((f) => f.wallIds.includes("b"));
    expect(sortIds(left.wallIds)).toEqual(["a", "c", "d", "p"]);
    expect(sortIds(right.wallIds)).toEqual(["a", "b", "c", "p"]);
    expect(left.wallIds).toContain("p");
    expect(right.wallIds).toContain("p");
  });

  it("supports a T-junction where the partition only touches one opposite wall", () => {
    // Partition from the midpoint of the bottom wall straight up to the
    // existing top-left corner — splits the rectangle into two triangles.
    const walls = [
      { id: "a", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
      { id: "b", a: { x: 10, y: 0 }, b: { x: 10, y: 5 } },
      { id: "c", a: { x: 10, y: 5 }, b: { x: 0, y: 5 } },
      { id: "d", a: { x: 0, y: 5 }, b: { x: 0, y: 0 } },
      { id: "p", a: { x: 5, y: 0 }, b: { x: 0, y: 5 } },
    ];
    const faces = findClosedAreas(walls);
    expect(faces).toHaveLength(2);
    // Triangle (corner cut off) + remaining quadrilateral.
    expect(sortIds(faces.map((f) => f.wallIds.length))).toEqual([3, 4]);
  });

  it("computes correct face areas for rooms of different sizes", () => {
    const walls = [
      { id: "e", a: { x: 3, y: 0 }, b: { x: 8.5, y: 0 } },
      { id: "c", a: { x: 8.5, y: 0 }, b: { x: 8.5, y: 5.5 } },
      { id: "0", a: { x: 8.5, y: 5.5 }, b: { x: 3, y: 5.5 } },
      { id: "eff", a: { x: 3, y: 5.5 }, b: { x: 3, y: 0 } },
      { id: "515", a: { x: 8.5, y: 0 }, b: { x: 13, y: 0 } },
      { id: "3d1", a: { x: 13, y: 0 }, b: { x: 13, y: 5.5 } },
      { id: "ace", a: { x: 13, y: 5.5 }, b: { x: 8.5, y: 5.5 } },
    ];
    const faces = findClosedAreas(walls);
    const areaOf = (points) => {
      let area = 0;
      for (let i = 0; i < points.length; i++) {
        const p = points[i], q = points[(i + 1) % points.length];
        area += p.x * q.y - q.x * p.y;
      }
      return Math.abs(area / 2);
    };
    const areas = faces.map((f) => areaOf(f.points)).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(4.5 * 5.5, 5); // narrower room
    expect(areas[1]).toBeCloseTo(5.5 * 5.5, 5); // wider room
  });
});

// ─── hasClosedBoundary ──────────────────────────────────────────────────────

describe("hasClosedBoundary", () => {
  it("is true for an empty storey (no walls drawn yet)", () => {
    expect(hasClosedBoundary([])).toBe(true);
  });

  it("is false for a dangling wall with no enclosed area", () => {
    const walls = [{ id: "1", a: { x: 0, y: 0 }, b: { x: 5, y: 0 } }];
    expect(hasClosedBoundary(walls)).toBe(false);
  });

  it("is true once walls enclose at least one area", () => {
    const walls = [
      { id: "a", a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
      { id: "b", a: { x: 5, y: 0 }, b: { x: 5, y: 5 } },
      { id: "c", a: { x: 5, y: 5 }, b: { x: 0, y: 5 } },
      { id: "d", a: { x: 0, y: 5 }, b: { x: 0, y: 0 } },
    ];
    expect(hasClosedBoundary(walls)).toBe(true);
  });
});
