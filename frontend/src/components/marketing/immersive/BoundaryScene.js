import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@/lib/motion";

/* The Execution Boundary — Avaira's signature 3D object.
 *
 * Three interlocking machined rings (the verification layers: identity, stake,
 * score, intent, time-and-scope read as five checks but compose into three
 * physical gates) around a dark octahedral core (the action). A lime pulse
 * (the request) travels the boundary; in the exploded view the rings separate
 * so each layer can be labelled from plain HTML beside the canvas.
 *
 * Rules the scene obeys:
 *  - essential text NEVER renders into the 3D canvas; labels live in HTML.
 *  - the animation loop pauses when the canvas is offscreen or the tab is hidden.
 *  - devicePixelRatio is clamped (1.75 desktop, 1.25 small screens) — this is a
 *    marketing surface, not a render farm.
 *  - prefers-reduced-motion renders one static assembled frame, no loop.
 *  - everything allocated here is disposed on unmount.
 *
 * props:
 *  - exploded: 0..1 — how far the rings separate along their axes (scroll-driven).
 *  - denied: boolean — pulse color/state for the decision act (lime vs stalled white).
 *  - className, ariaLabel: plain pass-throughs.
 * Anti-pattern: do not mount two heavy scenes on mobile; the landing mounts the
 * sticky one only when the viewport is >= 768px and the hero one everywhere.
 */

const LIME = 0xccff00;

export default function BoundaryScene({ exploded = 0, denied = false, className = "", ariaLabel = "Three machined rings around a dark core: the Avaira execution boundary" }) {
  const hostRef = useRef(null);
  const stateRef = useRef({ exploded, denied });
  stateRef.current = { exploded, denied };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    let raf = 0;
    let running = true;

    // three is imported lazily so the landing text paints before the scene boots.
    import("three").then((THREE) => {
      if (disposed || !host.isConnected) return;

      const small = window.innerWidth < 768;
      const reduced = prefersReducedMotion();
      const renderer = new THREE.WebGLRenderer({ antialias: !small, alpha: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.25 : 1.75));
      renderer.setSize(host.clientWidth, host.clientHeight);
      renderer.domElement.setAttribute("aria-hidden", "true");
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, host.clientWidth / Math.max(1, host.clientHeight), 0.1, 100);
      camera.position.set(0, 0.9, 8.4);

      /* materials — black anodized metal, one lime emissive accent */
      const metal = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.85, roughness: 0.3 });
      const darkGlass = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, metalness: 0.4, roughness: 0.22, transparent: true, opacity: 0.92 });
      const limeGlow = new THREE.MeshStandardMaterial({ color: 0x222200, emissive: LIME, emissiveIntensity: 1.6, metalness: 0.1, roughness: 0.4 });
      const pulseMat = new THREE.MeshStandardMaterial({ color: 0x111100, emissive: LIME, emissiveIntensity: 2.4 });

      /* the core — the action under review */
      const core = new THREE.Group();
      const coreSolid = new THREE.Mesh(new THREE.OctahedronGeometry(1.05, 0), darkGlass);
      const coreWire = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.OctahedronGeometry(1.08, 1)),
        new THREE.LineBasicMaterial({ color: 0x777777, transparent: true, opacity: 0.8 }),
      );
      const coreSeam = new THREE.Mesh(new THREE.TorusGeometry(1.32, 0.012, 8, 72), limeGlow);
      coreSeam.rotation.x = Math.PI / 2;
      core.add(coreSolid, coreWire, coreSeam);
      scene.add(core);

      /* the three gate rings — machined, toothed, individually rotatable */
      const ringGroup = new THREE.Group();
      const rings = [];
      const ringSpec = [
        { radius: 2.15, tilt: 0.42, axis: "z", teeth: small ? 24 : 48 },
        { radius: 2.85, tilt: -0.28, axis: "x", teeth: small ? 30 : 64 },
        { radius: 3.55, tilt: 0.16, axis: "z", teeth: small ? 36 : 80 },
      ];
      const tubeSeg = small ? 10 : 18;
      const ringSeg = small ? 64 : 128;
      ringSpec.forEach((spec, i) => {
        const g = new THREE.Group();
        const ring = new THREE.Mesh(new THREE.TorusGeometry(spec.radius, 0.055, tubeSeg, ringSeg), metal);
        g.add(ring);
        /* instanced teeth — the machined detail */
        const tooth = new THREE.BoxGeometry(0.05, 0.16, 0.05);
        const inst = new THREE.InstancedMesh(tooth, i === 1 ? limeGlow : metal, spec.teeth);
        const m = new THREE.Object3D();
        for (let t = 0; t < spec.teeth; t += 1) {
          const a = (t / spec.teeth) * Math.PI * 2;
          m.position.set(Math.cos(a) * spec.radius, Math.sin(a) * spec.radius, 0);
          m.rotation.set(0, 0, a);
          m.updateMatrix();
          inst.setMatrixAt(t, m.matrix);
        }
        g.add(inst);
        g.rotation.x = spec.axis === "x" ? Math.PI / 2 + spec.tilt : spec.tilt * 0.6;
        g.rotation.y = spec.axis === "z" ? spec.tilt : -spec.tilt * 0.8;
        rings.push({ group: g, spec });
        ringGroup.add(g);
      });
      scene.add(ringGroup);

      /* the request pulse */
      const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 12), pulseMat);
      scene.add(pulse);

      /* floor grid — fine technical grid, faded by fog */
      const grid = new THREE.GridHelper(46, 46, 0x1a1a1a, 0x101010);
      grid.position.y = -3.4;
      scene.add(grid);
      scene.fog = new THREE.Fog(0x050505, 9, 20);

      /* lighting — one white key, one lime rim, low ambient */
      const key = new THREE.DirectionalLight(0xffffff, 3.2);
      key.position.set(5, 7, 6);
      const rim = new THREE.PointLight(LIME, 60, 24, 1.6);
      rim.position.set(-4.2, 1.8, 3.2);
      const fill = new THREE.PointLight(0x8899aa, 14, 24);
      fill.position.set(4, -2, 4);
      scene.add(new THREE.AmbientLight(0xffffff, 0.22), key, rim, fill);

      /* pointer parallax — controlled, lerped, never chasing */
      const pointer = { x: 0, y: 0 };
      const smooth = { x: 0, y: 0 };
      const onPointer = (e) => {
        const r = host.getBoundingClientRect();
        pointer.x = ((e.clientX - r.left) / Math.max(1, r.width) - 0.5) * 2;
        pointer.y = ((e.clientY - r.top) / Math.max(1, r.height) - 0.5) * 2;
      };
      host.addEventListener("pointermove", onPointer);

      const resize = () => {
        if (!host.isConnected) return;
        renderer.setSize(host.clientWidth, host.clientHeight);
        camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(host);

      const io = new IntersectionObserver((entries) => { running = entries[0].isIntersecting; }, { threshold: 0 });
      io.observe(host);

      let t = 0;
      const baseSpread = [0, 1.5, 3.0];

      const readState = () => {
        const live = stateRef.current || {};
        const ex = typeof live.exploded === "number" ? live.exploded : (live.exploded && live.exploded.current) || 0;
        const deniedNow = typeof live.denied === "boolean" ? live.denied : (live.denied && live.denied.current) || false;
        return { ex, deniedNow };
      };

      const layout = () => {
        const { ex } = readState();
        rings.forEach((r, i) => {
          const spread = baseSpread[i] * ex;
          r.group.position.y = spread * 0.85;
          r.group.position.x = (i - 1) * spread * 0.9;
          const s = 1 + ex * 0.06 * (i - 1);
          r.group.scale.setScalar(s);
        });
        ringGroup.rotation.x = 0.12 + ex * 0.5;
        camera.position.z = 8.4 + ex * 1.6;
        camera.position.y = 0.9 + ex * 0.7;
        camera.lookAt(0, ex * 1.4, 0);
        coreSeam.material.emissiveIntensity = 1.6 - ex * 0.5;
      };

      const frame = () => {
        raf = requestAnimationFrame(frame);
        if (!running || document.hidden) return;
        t += 0.008;
        layout();
        smooth.x += (pointer.x - smooth.x) * 0.04;
        smooth.y += (pointer.y - smooth.y) * 0.04;
        ringGroup.rotation.y = t * 0.14 + smooth.x * 0.22;
        core.rotation.y = -t * 0.22;
        core.rotation.x = 0.1 + smooth.y * 0.1;
        rings.forEach((r, i) => {
          r.group.rotation.z = (i % 2 ? -1 : 1) * t * (0.05 + i * 0.03);
        });
        /* the request pulse: an orbit through the boundary; when denied it
           stalls between the second and third ring and dims */
        const { deniedNow } = readState();
        const ph = deniedNow ? 0.42 : (t * 0.5) % 1;
        const ang = ph * Math.PI * 2;
        const pr = 2.15 + ph * 1.5;
        pulse.position.set(Math.cos(ang) * pr, Math.sin(ang * 0.5) * 0.4, Math.sin(ang) * pr);
        pulseMat.emissiveIntensity = deniedNow ? 0.35 : 2.4;
        pulseMat.emissive.setHex(deniedNow ? 0x777777 : LIME);
        renderer.render(scene, camera);
      };

      if (reduced) {
        layout();
        renderer.render(scene, camera);
      } else {
        raf = requestAnimationFrame(frame);
      }

      cleanupRef = () => {
        cancelAnimationFrame(raf);
        host.removeEventListener("pointermove", onPointer);
        ro.disconnect();
        io.disconnect();
        scene.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((mm) => mm.dispose());
        });
        renderer.dispose();
        if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      };
    });

    let cleanupRef = null;
    return () => {
      disposed = true;
      if (cleanupRef) cleanupRef();
    };
  }, []);

  return (
    <div ref={hostRef} className={`boundary-scene ${className}`} role="img" aria-label={ariaLabel} style={{ width: "100%", height: "100%" }} />
  );
}
