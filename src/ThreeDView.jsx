import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

// Get room data from localStorage
const loadFloorPlanData = () => {
  try {
    const rooms = JSON.parse(localStorage.getItem("floorplan_rooms")) || { 0: [], 1: [], 2: [] };
    const ceilings = JSON.parse(localStorage.getItem("floorplan_ceilings")) || { 0: 3.0, 1: 2.7, 2: 2.5 };
    return { rooms, ceilings };
  } catch {
    return { rooms: { 0: [], 1: [], 2: [] }, ceilings: { 0: 3.0, 1: 2.7, 2: 2.5 } };
  }
};

// Create wall geometry with window/door openings
const createWallWithOpenings = (ptA, ptB, height, openings) => {
  const group = new THREE.Group();
  
  const wallLength = Math.sqrt((ptB.x - ptA.x) ** 2 + (ptB.y - ptA.y) ** 2);
  const direction = {
    x: (ptB.x - ptA.x) / wallLength,
    y: (ptB.y - ptA.y) / wallLength,
  };
  
  // Sort openings by offset
  const sortedOpenings = [...openings].sort((a, b) => a.offset - b.offset);
  
  let wallSegments = [];
  let currentPos = 0;
  
  // Create wall segments between openings
  for (const opening of sortedOpenings) {
    const openStart = Math.max(0, opening.offset);
    const openEnd = Math.min(wallLength, opening.offset + opening.width);
    
    if (openEnd <= openStart || openStart >= wallLength) continue;
    
    // Add solid wall segment before opening
    if (currentPos < openStart) {
      wallSegments.push({ start: currentPos, end: openStart, hasOpening: false });
    }
    
    // Add opening
    wallSegments.push({
      start: openStart,
      end: openEnd,
      hasOpening: true,
      type: opening.type,
      opening: opening,
      height: opening.height || (opening.type === "window" ? 1.2 : 2.1),
      sillHeight: opening.sillHeight || 0,
    });
    
    currentPos = openEnd;
  }
  
  // Add remaining wall
  if (currentPos < wallLength) {
    wallSegments.push({ start: currentPos, end: wallLength, hasOpening: false });
  }
  
  // If no openings, create one solid segment
  if (wallSegments.length === 0) {
    wallSegments.push({ start: 0, end: wallLength, hasOpening: false });
  }
  
  // Create geometries for each segment
  for (const segment of wallSegments) {
    if (segment.hasOpening) {
      const openingHeight = segment.height;
      const sillHeight = segment.sillHeight;
      const wallThickness = 0.15;
      
      // Lintel (above opening)
      if (sillHeight + openingHeight < height) {
        const lintelHeight = height - (sillHeight + openingHeight);
        const startPt = {
          x: ptA.x + direction.x * segment.start,
          y: ptA.y + direction.y * segment.start,
        };
        const endPt = {
          x: ptA.x + direction.x * segment.end,
          y: ptA.y + direction.y * segment.end,
        };
        
        const lintelGeom = new THREE.BoxGeometry(
          segment.end - segment.start,
          wallThickness,
          lintelHeight
        );
        const lintelMesh = new THREE.Mesh(lintelGeom, new THREE.MeshPhongMaterial({ color: 0xcccccc }));
        lintelMesh.position.set(
          (startPt.x + endPt.x) / 2,
          (startPt.y + endPt.y) / 2,
          sillHeight + openingHeight + lintelHeight / 2
        );
        group.add(lintelMesh);
      }
      
      // Sill (below opening for windows)
      if (segment.type === "window" && sillHeight > 0) {
        const startPt = {
          x: ptA.x + direction.x * segment.start,
          y: ptA.y + direction.y * segment.start,
        };
        const endPt = {
          x: ptA.x + direction.x * segment.end,
          y: ptA.y + direction.y * segment.end,
        };
        
        const sillGeom = new THREE.BoxGeometry(
          segment.end - segment.start,
          wallThickness,
          sillHeight
        );
        const sillMesh = new THREE.Mesh(sillGeom, new THREE.MeshPhongMaterial({ color: 0xcccccc }));
        sillMesh.position.set(
          (startPt.x + endPt.x) / 2,
          (startPt.y + endPt.y) / 2,
          sillHeight / 2
        );
        group.add(sillMesh);
      }
      
      // Left jamb
      const leftJambGeom = new THREE.BoxGeometry(wallThickness, wallThickness, segment.type === "window" ? segment.height : height);
      const leftJambMesh = new THREE.Mesh(leftJambGeom, new THREE.MeshPhongMaterial({ color: 0xaaaaaa }));
      const startPtL = {
        x: ptA.x + direction.x * segment.start,
        y: ptA.y + direction.y * segment.start,
      };
      leftJambMesh.position.set(
        startPtL.x,
        startPtL.y,
        (segment.type === "window" ? segment.sillHeight : 0) + (segment.type === "window" ? segment.height : height) / 2
      );
      group.add(leftJambMesh);
      
      // Right jamb
      const rightJambGeom = new THREE.BoxGeometry(wallThickness, wallThickness, segment.type === "window" ? segment.height : height);
      const rightJambMesh = new THREE.Mesh(rightJambGeom, new THREE.MeshPhongMaterial({ color: 0xaaaaaa }));
      const endPtR = {
        x: ptA.x + direction.x * segment.end,
        y: ptA.y + direction.y * segment.end,
      };
      rightJambMesh.position.set(
        endPtR.x,
        endPtR.y,
        (segment.type === "window" ? segment.sillHeight : 0) + (segment.type === "window" ? segment.height : height) / 2
      );
      group.add(rightJambMesh);
    } else {
      // Solid wall segment
      const startPt = {
        x: ptA.x + direction.x * segment.start,
        y: ptA.y + direction.y * segment.start,
      };
      const endPt = {
        x: ptA.x + direction.x * segment.end,
        y: ptA.y + direction.y * segment.end,
      };
      
      const wallThickness = 0.15;
      const wallGeom = new THREE.BoxGeometry(
        segment.end - segment.start,
        wallThickness,
        height
      );
      const wallMaterial = new THREE.MeshPhongMaterial({
        color: 0xdddddd,
        side: THREE.DoubleSide,
      });
      const wallMesh = new THREE.Mesh(wallGeom, wallMaterial);
      wallMesh.position.set(
        (startPt.x + endPt.x) / 2,
        (startPt.y + endPt.y) / 2,
        height / 2
      );
      group.add(wallMesh);
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

    const { rooms: roomsByStorey, ceilings: ceilingHeights } = loadFloorPlanData();
    
    // Check if we have any rooms
    const hasRooms = Object.values(roomsByStorey).some(storeyRooms => storeyRooms.length > 0);
    
    if (!hasRooms) {
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
    renderer.shadowMap.type = THREE.PCFShadowShadowMap;
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

    // Add ground plane
    const groundGeom = new THREE.PlaneGeometry(200, 200);
    const groundMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = 0;
    ground.receiveShadow = true;
    scene.add(ground);

    // Color palette for rooms
    const PALETTE = [
      0x60a5fa,
      0x34d399,
      0xfbbf24,
      0xf47272,
      0xc084fc,
      0xfb923c,
    ];

    let zOffset = 0;
    let roomIndex = 0;

    // Add rooms for each storey
    for (const [storeyIdx, storeyRooms] of Object.entries(roomsByStorey)) {
      const ceilingHeight = ceilingHeights[storeyIdx] || 3.0;

      for (const room of storeyRooms) {
        if (!room.points || room.points.length < 3) continue;

        const color = PALETTE[roomIndex % PALETTE.length];
        const material = new THREE.MeshPhongMaterial({
          color: color,
          side: THREE.DoubleSide,
          flatShading: false,
        });

        // Create walls
        const points = room.points;
        for (let i = 0; i < points.length; i++) {
          const ptA = points[i];
          const ptB = points[(i + 1) % points.length];
          const openings = (room.openings || []).filter((o) => o.wallIdx === i);

          const wallGroup = createWallWithOpenings(ptA, ptB, ceilingHeight, openings);
          if (wallGroup) {
            wallGroup.position.z = zOffset;
            wallGroup.castShadow = true;
            wallGroup.receiveShadow = true;
            scene.add(wallGroup);
          }
        }

        // Create floor
        const floorShape = new THREE.Shape();
        floorShape.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          floorShape.lineTo(points[i].x, points[i].y);
        }
        floorShape.lineTo(points[0].x, points[0].y);

        const floorGeom = new THREE.ShapeGeometry(floorShape);
        const floorMaterial = new THREE.MeshPhongMaterial({
          color: 0x333333,
          side: THREE.DoubleSide,
        });
        const floorMesh = new THREE.Mesh(floorGeom, floorMaterial);
        floorMesh.position.z = zOffset;
        floorMesh.rotation.x = 0;
        floorMesh.castShadow = true;
        floorMesh.receiveShadow = true;
        scene.add(floorMesh);

        // Create ceiling
        const ceilingGeom = new THREE.ShapeGeometry(floorShape);
        const ceilingMaterial = new THREE.MeshPhongMaterial({
          color: 0x444444,
          side: THREE.DoubleSide,
        });
        const ceilingMesh = new THREE.Mesh(ceilingGeom, ceilingMaterial);
        ceilingMesh.position.z = zOffset + ceilingHeight;
        ceilingMesh.rotation.x = 0;
        ceilingMesh.castShadow = true;
        ceilingMesh.receiveShadow = true;
        scene.add(ceilingMesh);

        roomIndex++;
      }

      zOffset += ceilingHeight + 0.3; // Add space between storeys
    }

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
