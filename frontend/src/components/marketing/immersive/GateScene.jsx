import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { prefersReducedMotion } from "@/lib/motion";

/* ══════════════════════════════════════════════════════════════════════════
   THE GATE — Avaira's signature 3D object, now on React Three Fiber.

   A programmable execution boundary: three machined hexagonal apertures
   (the physical gates — identity, stake, score compose the checks) around a
   faceted dark core (the committed intent) with a lime core-light inside it.
   A lime scan-ring — the request — travels the boundary on a slow loop, and a
   lime beam — the permitted path — runs through the axis. When the page
   scrolls into Act III the apertures separate along the axis so each gate can
   be labelled from semantic HTML beside the canvas.

   Rules the scene obeys (unchanged from the first boundary scene):
    - essential text NEVER renders into the canvas; labels live in HTML.
    - the render loop does no work while the host is offscreen.
    - DPR is clamped: [1, 1.75] desktop, [1, 1.25] small screens.
    - prefers-reduced-motion renders one static assembled pose, no loop.
    - R3F disposes all GPU resources when the canvas unmounts.

   props:
    - progressRef: mutable ref, 0..1 — aperture separation (scroll-driven,
      read inside useFrame so 60fps scrolling never re-renders React).
    - className / ariaLabel: pass-throughs.

   Anti-pattern: mounting two heavy canvases on mobile. The landing mounts
   the sticky Act III scene only on viewports >= 768px; the hero scene is the
   single mobile scene.

   This module is loaded through React.lazy from the landing, so it (and
   three/R3F) code-splits out of the main bundle and the page text paints
   first. It is also never evaluated by jest static renders.
   ══════════════════════════════════════════════════════════════════════════ */

const LIME = new THREE.Color("#ccff00");

/* the committed intent: faceted dark core, lime wireframe cage, pulsing heart */
function IntentCore({ progressRef, reduced }) {
  const core = useRef(null);
  const wire = useRef(null);
  const heart = useRef(null);
  useFrame(({ clock }) => {
    if (reduced) return;
    const t = clock.elapsedTime;
    const p = progressRef.current ?? 0;
    if (core.current) {
      core.current.rotation.y = t * 0.22;
      core.current.rotation.x = Math.sin(t * 0.16) * 0.18;
    }
    if (wire.current) {
      wire.current.rotation.y = -t * 0.14;
      wire.current.scale.setScalar(1 + p * 0.12);
    }
    if (heart.current) {
      const pulse = 1 + Math.sin(t * 1.4) * 0.16;
      heart.current.scale.setScalar(pulse);
    }
  });
  return (
    <group>
      <mesh ref={core}>
        <icosahedronGeometry args={[0.8, 0]} />
        <meshStandardMaterial color="#151519" metalness={0.85} roughness={0.3} flatShading />
      </mesh>
      <mesh ref={wire}>
        <icosahedronGeometry args={[0.86, 0]} />
        <meshBasicMaterial color={LIME} wireframe transparent opacity={0.28} toneMapped={false} />
      </mesh>
      <mesh ref={heart}>
        <octahedronGeometry args={[0.26, 0]} />
        <meshBasicMaterial color={LIME} toneMapped={false} />
      </mesh>
      <pointLight color={LIME} intensity={1.6} distance={4.2} />
    </group>
  );
}

/* the permitted path: a lime beam on the axis, intensifying with separation */
function PermitBeam({ progressRef }) {
  const mat = useRef(null);
  useFrame(() => {
    const p = progressRef.current ?? 0;
    if (mat.current) mat.current.opacity = 0.55 + p * 0.35;
  });
  return (
    <mesh>
      <cylinderGeometry args={[0.028, 0.028, 9, 12, 1, true]} />
      <meshBasicMaterial ref={mat} color={LIME} transparent opacity={0.55} toneMapped={false} />
    </mesh>
  );
}

/* the request: a thin lime ring travelling through the gates, forever */
function ScanRing() {
  const ref = useRef(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    /* one pass every 7s, eased in and out so it reads as deliberate */
    const t = (clock.elapsedTime % 7) / 7;
    const eased = 0.5 - Math.cos(Math.PI * 2 * t) / 2;
    m.position.z = -3.2 + eased * 6.4;
    m.scale.setScalar(1 - Math.abs(eased - 0.5) * 0.25);
  });
  return (
    <mesh ref={ref}>
      <torusGeometry args={[1.65, 0.012, 8, 120]} />
      <meshBasicMaterial color={LIME} toneMapped={false} />
    </mesh>
  );
}

/* pointer parallax — the gate leans toward the cursor, never chases it */
function PointerLean({ group }) {
  const { pointer } = useThree();
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.rotation.y += (pointer.x * 0.14 - g.rotation.y) * 0.05;
    g.rotation.x += (-pointer.y * 0.1 - g.rotation.x) * 0.05;
  });
  return null;
}

/* the whole gate: apertures separate along the axis as Act III scrolls */
function Gate({ progressRef, reduced, visibleRef }) {
  const group = useRef(null);
  const aps = [useRef(null), useRef(null), useRef(null)];
  const camera = useThree((s) => s.camera);

  useFrame(({ clock }) => {
    if (!visibleRef?.current && clock.elapsedTime > 2) return; /* offscreen: rest */
    const t = clock.elapsedTime;
    const p = reduced ? 0 : progressRef.current ?? 0;
    /* entrance: settle from slightly larger and closer, over 1.4s */
    const settle = Math.min(1, t / 1.4);
    const ease = 1 - Math.pow(1 - settle, 3);
    const g = group.current;
    if (g) {
      g.scale.setScalar(0.94 + ease * 0.06);
      g.rotation.z = (1 - ease) * 0.06;
    }
    camera.position.z = 10 - ease * 1.1;
    /* act III separation: apertures slide along z, outermost first */
    aps.forEach((r, i) => {
      const m = r.current;
      if (!m) return;
      m.position.z = p * (2.4 - i * 0.75);
      m.rotation.x = p * (i - 1) * 0.22;
    });
  });

  return (
    <group ref={group}>
      <PointerLean group={group} />
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={aps[i]} rotation={[Math.PI / 2.6, 0, i * 0.5]}>
          <torusGeometry args={[2.15 - i * 0.5, 0.09 - i * 0.015, 6, 160]} />
          <meshStandardMaterial color="#1c1c20" metalness={0.92} roughness={0.28} flatShading />
        </mesh>
      ))}
      <IntentCore progressRef={progressRef} reduced={reduced} />
      <PermitBeam progressRef={progressRef} />
      {reduced ? null : <ScanRing />}
    </group>
  );
}

export default function GateScene({ progressRef, className = "", ariaLabel = "Three machined apertures around a dark faceted core with a lime axis: the Avaira execution boundary" }) {
  const hostRef = useRef(null);
  const visibleRef = useRef(true);
  const reduced = useMemo(() => (typeof window !== "undefined" ? prefersReducedMotion() : false), []);
  const [small, setSmall] = useState(typeof window !== "undefined" ? window.innerWidth < 768 : false);

  /* pause the loop's work when the host leaves the viewport */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") return undefined;
    const io = new IntersectionObserver(([e]) => { visibleRef.current = e.isIntersecting; }, { rootMargin: "120px" });
    io.observe(host);
    return () => io.disconnect();
  }, []);

  /* the poster behind the canvas until WebGL boots */
  const poster = (
    <div className="imm-canvas-poster" aria-hidden="true">
      <span /><span /><span />
    </div>
  );

  return (
    <div className={`imm-canvas ${className}`} ref={hostRef} role="img" aria-label={ariaLabel}>
      <Canvas
        dpr={[1, small ? 1.25 : 1.75]}
        camera={{ fov: 35, position: [0, 0.4, 9] }}
        gl={{ antialias: !small, alpha: true, powerPreference: "high-performance" }}
        frameloop={reduced ? "demand" : "always"}
        style={{ position: "absolute", inset: 0 }}
      >
        <ambientLight intensity={0.22} />
        <directionalLight position={[4, 6, 6]} intensity={1.7} color="#fff6e0" />
        <pointLight position={[-6, -2, -3]} intensity={0.9} color={LIME} />
        <pointLight position={[-4, 3, 5]} intensity={0.5} color="#e8e8ff" />
        <Gate progressRef={progressRef} reduced={reduced} visibleRef={visibleRef} />
      </Canvas>
      {poster}
    </div>
  );
}
