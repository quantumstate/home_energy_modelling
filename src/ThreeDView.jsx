import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { buildingModelFromState, processBuilding } from "./geometryProcessor.js";

// Load and process the BuildingModel written by FloorPlanUI.
const loadProcessedBuilding = () => {
  try {
    const raw = localStorage.getItem("building_model");
    if (raw) {
      const model = JSON.parse(raw);
      return processBuilding(model);
    }
  } catch {}

  // Fallback: reconstruct from raw editor state if building_model not yet written.
  try {
    const roomsByStorey = JSON.parse(localStorage.getItem("floorplan_rooms")) || { 0: [], 1: [], 2: [] };
    const ceilingHeights = JSON.parse(localStorage.getItem("floorplan_ceilings")) || { 0: 3.0, 1: 2.7, 2: 2.5 };
    const globalU = JSON.parse(localStorage.getItem("floorplan_uvalues")) || null;
    const model = buildingModelFromState({ roomsByStorey, ceilingHeights, globalU });
    return processBuilding(model);
  } catch {
    return null;
  }
};

// Create wall geometry with window/door openings.
//
// Geometry is built in wall-local space (wall runs along local +X, height along
// local +Y, thickness along local +Z) then the group is rotated around world Y
// and translated to ptA so it lands in the right place in the scene.
//
// Floor plan (x, y) maps to 3D (x, elevation, y) — Three.js Y-up convention.
const createWallWithOpenings = (ptA, ptB, wallHeight, openings) => {
  const group = new THREE.Group();
  const wallThickness = 0.15;

  const dx = ptB.x - ptA.x;
  const dy = ptB.y - ptA.y;
  const wallLength = Math.sqrt(dx * dx + dy * dy);
  if (wallLength < 0.01) return group;

  // Rotate group around Y so local +X aligns with wall direction in XZ plane.
  // Floor plan +y maps to 3D +z, so wall angle uses atan2(dy, dx).
  group.rotation.y = -Math.atan2(dy, dx);
  // Position group at ptA (floor plan → world: x stays x, y → z).
  // Elevation (Y) is applied by the caller via group.position.y.
  group.position.set(ptA.x, 0, ptA.y);

  // Build segment list (same logic as before, independent of direction).
  const sortedOpenings = [...openings].sort((a, b) => a.offset - b.offset);
  const wallSegments = [];
  let currentPos = 0;

  for (const opening of sortedOpenings) {
    const openStart = Math.max(0, opening.offset);
    const openEnd   = Math.min(wallLength, opening.offset + opening.width);
    if (openEnd <= openStart || openStart >= wallLength) continue;

    if (currentPos < openStart)
      wallSegments.push({ start: currentPos, end: openStart, hasOpening: false });

    wallSegments.push({
      start: openStart, end: openEnd, hasOpening: true,
      type:       opening.type,
      openHeight: opening.height     ?? (opening.type === "window" ? 1.2 : 2.1),
      sillHeight: opening.sillHeight ?? 0,
    });
    currentPos = openEnd;
  }
  if (currentPos < wallLength)
    wallSegments.push({ start: currentPos, end: wallLength, hasOpening: false });
  if (wallSegments.length === 0)
    wallSegments.push({ start: 0, end: wallLength, hasOpening: false });

  const solidMat  = new THREE.MeshPhongMaterial({ color: 0xdddddd });
  const jambMat   = new THREE.MeshPhongMaterial({ color: 0xaaaaaa });

  // All positions are in wall-local space: X = along wall, Y = up, Z = thickness.
  for (const seg of wallSegments) {
    const segLen = seg.end - seg.start;
    const segMid = seg.start + segLen / 2;

    if (!seg.hasOpening) {
      // Solid wall panel: full height
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(segLen, wallHeight, wallThickness),
        solidMat,
      );
      mesh.position.set(segMid, wallHeight / 2, 0);
      group.add(mesh);
    } else {
      const { openHeight, sillHeight, type } = seg;
      const openMid = seg.start + segLen / 2;

      // Lintel above opening
      const lintelH = wallHeight - sillHeight - openHeight;
      if (lintelH > 0.001) {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(segLen, lintelH, wallThickness),
          solidMat,
        );
        m.position.set(openMid, sillHeight + openHeight + lintelH / 2, 0);
        group.add(m);
      }

      // Sill below window opening
      if (type === "window" && sillHeight > 0.001) {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(segLen, sillHeight, wallThickness),
          solidMat,
        );
        m.position.set(openMid, sillHeight / 2, 0);
        group.add(m);
      }

      // Vertical jambs either side of the opening
      const jambH = type === "window" ? openHeight : wallHeight - sillHeight;
      const jambY = (type === "window" ? sillHeight : 0) + jambH / 2;

      const leftJamb = new THREE.Mesh(
        new THREE.BoxGeometry(wallThickness, jambH, wallThickness),
        jambMat,
      );
      leftJamb.position.set(seg.start, jambY, 0);
      group.add(leftJamb);

      const rightJamb = new THREE.Mesh(
        new THREE.BoxGeometry(wallThickness, jambH, wallThickness),
        jambMat,
      );
      rightJamb.position.set(seg.end, jambY, 0);
      group.add(rightJamb);
    }
  }

  return group;
};

export default function ThreeDView() {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState("");

  useEffect(() => {
    if (!mountRef.current) return;

    // Clear any existing renderer from StrictMode double-mount
    const existingCanvas = mountRef.current.querySelector("canvas");
    if (existingCanvas) {
      mountRef.current.removeChild(existingCanvas);
    }

    const processedBuilding = loadProcessedBuilding();

    if (!processedBuilding || processedBuilding.rooms.length === 0) {
      setInfo("No rooms in floor plan. Draw rooms in the Floor Plan tab first.");
      setLoading(false);
      return;
    }

    // Initialize Three.js scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05090f);
    scene.fog = new THREE.Fog(0x05090f, 100, 200);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      75,
      mountRef.current.clientWidth / mountRef.current.clientHeight,
      0.1,
      1000
    );
    camera.position.set(10, 10, 15);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mountRef.current.clientWidth, mountRef.current.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mountRef.current.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(20, 20, 15);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    directionalLight.shadow.camera.far = 100;
    directionalLight.shadow.camera.left = -50;
    directionalLight.shadow.camera.right = 50;
    directionalLight.shadow.camera.top = 50;
    directionalLight.shadow.camera.bottom = -50;
    scene.add(directionalLight);

    // Add ground plane — rotation.x = -π/2 lays PlaneGeometry flat in the XZ plane at Y=0.
    const groundGeom = new THREE.PlaneGeometry(200, 200);
    const groundMat = new THREE.MeshPhongMaterial({ color: 0x336a28 });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    scene.add(ground);

    const PALETTE = [
      0x60a5fa, 0x34d399, 0xfbbf24, 0xf47272, 0xc084fc, 0xfb923c,
    ];

    // Add rooms using ProcessedBuilding data
    processedBuilding.rooms.forEach((processedRoom, roomIndex) => {
      const storey = processedBuilding.source.storeys[processedRoom.storeyIndex];
      const zOffset = storey.floorElevation;
      const ceilingHeight = storey.ceilingHeight;

      // Retrieve original room points for floor/ceiling shapes
      const sourceRoom = storey.rooms.find(r => r.id === processedRoom.sourceId);
      if (!sourceRoom || sourceRoom.points.length < 3) return;
      const points = sourceRoom.points;

      // Walls
      for (const wall of processedRoom.walls) {
        // Re-derive opening offsets from ProcessedOpening.worldPosition
        const wallLen = wall.length;
        const wallDx  = wallLen > 0 ? (wall.endPoint.x - wall.startPoint.x) / wallLen : 0;
        const wallDy  = wallLen > 0 ? (wall.endPoint.y - wall.startPoint.y) / wallLen : 0;
        const openings = wall.openings.map(o => ({
          type:       o.type,
          offset:     (o.worldPosition.x - wall.startPoint.x) * wallDx
                    + (o.worldPosition.y - wall.startPoint.y) * wallDy,
          width:      o.width,
          height:     o.height,
          sillHeight: o.sillHeight,
        }));
        const wallGroup = createWallWithOpenings(wall.startPoint, wall.endPoint, ceilingHeight, openings);
        // Elevation: Y is up in Three.js — floor plan y maps to world z inside
        // createWallWithOpenings, so only the vertical offset needs setting here.
        wallGroup.position.y = zOffset;
        wallGroup.castShadow = true;
        wallGroup.receiveShadow = true;
        scene.add(wallGroup);
      }

      // Floor / ceiling — ShapeGeometry lies in XY by default; rotate π/2 around X
      // so floor plan (x, y) maps to world (x, elevation, y) matching the walls.
      const floorShape = new THREE.Shape();
      floorShape.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) floorShape.lineTo(points[i].x, points[i].y);

      const floorMesh = new THREE.Mesh(
        new THREE.ShapeGeometry(floorShape),
        new THREE.MeshPhongMaterial({ color: 0x333333, side: THREE.DoubleSide }),
      );
      floorMesh.rotation.x = Math.PI / 2;
      floorMesh.position.y = zOffset;
      floorMesh.receiveShadow = true;
      scene.add(floorMesh);

      const ceilingMesh = new THREE.Mesh(
        new THREE.ShapeGeometry(floorShape),
        new THREE.MeshPhongMaterial({ color: 0x444444, side: THREE.DoubleSide }),
      );
      ceilingMesh.rotation.x = Math.PI / 2;
      ceilingMesh.position.y = zOffset + ceilingHeight;
      scene.add(ceilingMesh);
    });

    // Handle window resize
    const handleResize = () => {
      const width = mountRef.current.clientWidth;
      const height = mountRef.current.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    window.addEventListener("resize", handleResize);

    // Handle mouse controls
    let isDragging = false;
    let previousMousePosition = { x: 0, y: 0 };

    renderer.domElement.addEventListener("mousedown", (e) => {
      isDragging = true;
      previousMousePosition = { x: e.clientX, y: e.clientY };
    });

    renderer.domElement.addEventListener("mousemove", (e) => {
      if (isDragging) {
        const deltaX = e.clientX - previousMousePosition.x;
        const deltaY = e.clientY - previousMousePosition.y;

        camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), deltaX * 0.01);
        camera.position.applyAxisAngle(new THREE.Vector3(1, 0, 0), deltaY * 0.01);
        camera.lookAt(0, 0, 0);
      }
      previousMousePosition = { x: e.clientX, y: e.clientY };
    });

    renderer.domElement.addEventListener("mouseup", () => {
      isDragging = false;
    });

    renderer.domElement.addEventListener("wheel", (e) => {
      e.preventDefault();
      const direction = camera.position.clone().normalize();
      const distance = camera.position.length();
      const newDistance = Math.max(5, Math.min(100, distance + e.deltaY * 0.05));
      camera.position.copy(direction.multiplyScalar(newDistance));
      camera.lookAt(0, 0, 0);
    });

    // Animation loop
    let animationId;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    setLoading(false);

    // Cleanup
    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationId);
      if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
        mountRef.current.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#05090f",
      }}
    >
      {loading && (
        <div
          style={{
            color: "#2d5a8a",
            fontFamily: "monospace",
            fontSize: 12,
            textAlign: "center",
            zIndex: 10,
          }}
        >
          Loading 3D view...
        </div>
      )}
      {info && (
        <div
          style={{
            color: "#2d5a8a",
            fontFamily: "monospace",
            fontSize: 12,
            textAlign: "center",
            zIndex: 10,
            padding: "20px",
          }}
        >
          {info}
        </div>
      )}
    </div>
  );
}
