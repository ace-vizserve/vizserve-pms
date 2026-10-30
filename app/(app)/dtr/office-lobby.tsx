"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Mesh, MeshStandardMaterial } from "three";

import { Block, Round } from "./office-block";
import { Cctv } from "./office-cctv";
import { Picture, useTextTexture } from "./office-props";

/**
 * The lobby inside the main entrance: carpets, a security desk with a guard and
 * a wall of CCTV monitors, turnstiles across the way in, visitor seating, and
 * cameras watching it all — the CCTV camera here is reused round the office.
 *
 * It fills the free floor between the all-hands room and the lounge. `x0…x1`,
 * `z0…z1` is that floor; the entrance doors are at `entranceX` in the wall at `z1`.
 */

const NAVY = "#1e3a5f";
const RUNNER = "#2f4a8f";

/* -------------------------------------------------------------------------- */
/* Security                                                                     */
/* -------------------------------------------------------------------------- */

/** The guard, seated, in uniform and cap. Faces −Z in its own frame. */
function Guard() {
  const skin = "#c68b5f";
  return (
    <group>
      <Block position={[0, 0.56, -0.14]} size={[0.44, 0.16, 0.5]} color="#111827" />
      <Block position={[-0.11, 0.27, -0.36]} size={[0.18, 0.44, 0.18]} color="#111827" />
      <Block position={[0.11, 0.27, -0.36]} size={[0.18, 0.44, 0.18]} color="#111827" />
      <Block position={[0, 0.93, 0.04]} size={[0.5, 0.58, 0.28]} color={NAVY} />
      <Block position={[0.14, 1.08, -0.105]} size={[0.08, 0.1, 0.01]} color="#facc15" shadow={false} />
      <Block position={[-0.32, 0.98, -0.14]} size={[0.14, 0.14, 0.44]} color={NAVY} />
      <Block position={[0.32, 0.98, -0.14]} size={[0.14, 0.14, 0.44]} color={NAVY} />
      <Block position={[-0.32, 0.98, -0.42]} size={[0.14, 0.14, 0.12]} color={skin} />
      <Block position={[0.32, 0.98, -0.42]} size={[0.14, 0.14, 0.12]} color={skin} />
      <group position={[0, 1.42, 0.02]}>
        <Block position={[0, 0, 0]} size={[0.36, 0.36, 0.36]} color={skin} />
        <Block position={[-0.08, 0.02, -0.185]} size={[0.06, 0.06, 0.02]} color="#111111" />
        <Block position={[0.08, 0.02, -0.185]} size={[0.06, 0.06, 0.02]} color="#111111" />
        {/* Cap and its brim. */}
        <Block position={[0, 0.22, 0.01]} size={[0.4, 0.12, 0.4]} color={NAVY} />
        <Block position={[0, 0.17, -0.25]} size={[0.38, 0.03, 0.16]} color="#0f172a" />
        <Block position={[0, 0.24, -0.195]} size={[0.08, 0.06, 0.01]} color="#facc15" shadow={false} />
      </group>
    </group>
  );
}

/** A 2 × 3 wall of CCTV feeds; one changes every couple of seconds. Faces +Z. */
function MonitorWall() {
  const screens = useRef<(MeshStandardMaterial | null)[]>([]);
  const rec = useRef<Mesh>(null);
  const feeds = ["#334155", "#3f4d63", "#2b3a4f", "#475569", "#30425a", "#3b4a5e"];
  useFrame(({ clock }) => {
    const step = Math.floor(clock.elapsedTime / 2.2);
    screens.current.forEach((material, i) => {
      if (!material) return;
      const lit = (step + i) % 6 === 0;
      material.emissiveIntensity = lit ? 0.7 : 0.35;
    });
    if (rec.current) rec.current.visible = Math.floor(clock.elapsedTime * 1.4) % 2 === 0;
  });
  return (
    <group>
      <Block position={[0, 1.45, -0.05]} size={[2.1, 1.25, 0.12]} color="#111827" />
      {feeds.map((c, i) => (
        <group key={i} position={[-0.68 + (i % 3) * 0.68, 1.75 - Math.floor(i / 3) * 0.6, 0.02]}>
          <mesh>
            <boxGeometry args={[0.62, 0.52, 0.02]} />
            <meshStandardMaterial
              ref={(material) => {
                screens.current[i] = material;
              }}
              color={c}
              emissive="#64748b"
              emissiveIntensity={0.35}
            />
          </mesh>
          {/* A suggestion of a corridor in each feed. */}
          <Block position={[0, -0.12, 0.012]} size={[0.5, 0.08, 0.005]} color="#94a3b8" shadow={false} />
          <Block position={[-0.12, 0.05, 0.012]} size={[0.06, 0.2, 0.005]} color="#cbd5e1" shadow={false} />
        </group>
      ))}
      <mesh ref={rec} position={[0.95, 2.0, 0.04]}>
        <boxGeometry args={[0.05, 0.05, 0.01]} />
        <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={1.2} />
      </mesh>
    </group>
  );
}

/** The security desk, guard and monitor wall. Faces −X: visitors come in from that side. */
function SecurityDesk({ x, z }: { x: number; z: number }) {
  const sign = useTextTexture("SECURITY", "#ffffff", 130, 1000, 200);
  return (
    <group position={[x, 0, z]} rotation={[0, -Math.PI / 2, 0]}>
      {/* Counter: front panel, top, and the return. */}
      <Block position={[0, 0.55, 0.3]} size={[2.8, 1.1, 0.12]} color={NAVY} />
      <Block position={[0, 1.13, 0.22]} size={[3, 0.06, 0.5]} color="#e5e7eb" />
      <Block position={[0, 0.74, -0.15]} size={[2.8, 0.05, 0.75]} color="#f5f4f0" />
      <Block position={[1.45, 0.55, -0.3]} size={[0.12, 1.1, 1.2]} color={NAVY} />
      <group position={[0, 0.6, 0.37]}>
        <Picture texture={sign} w={1.4} h={0.28} />
      </group>
      {/* Sign-in book and a pen. */}
      <Block position={[-0.8, 1.17, 0.25]} size={[0.4, 0.03, 0.3]} color="#ffffff" />
      <Block position={[-0.68, 1.19, 0.25]} size={[0.02, 0.02, 0.18]} color="#1f2937" rotation={[0, 0.5, 0]} />
      {/* Two monitors on the desk. */}
      {[-0.4, 0.35].map((mx) => (
        <group key={mx} position={[mx, 0.77, -0.05]}>
          <Block position={[0, 0.06, 0]} size={[0.06, 0.12, 0.06]} color="#1f2937" />
          <Block position={[0, 0.3, 0]} size={[0.6, 0.38, 0.04]} color="#1f2937" />
          <Block position={[0, 0.3, 0.025]} size={[0.54, 0.32, 0.005]} color="#64748b" emissive="#94a3b8" emissiveIntensity={0.4} shadow={false} />
        </group>
      ))}
      {/* The guard, at the desk, looking out. */}
      <group position={[0, 0, -0.75]} rotation={[0, Math.PI, 0]}>
        <Block position={[0, 0.46, 0]} size={[0.56, 0.08, 0.56]} color="#1f2937" />
        <Block position={[0, 0.82, 0.27]} size={[0.56, 0.64, 0.08]} color="#1f2937" />
        <Guard />
      </group>
      {/* The wall of feeds behind. */}
      <group position={[0, 0, -1.5]}>
        <MonitorWall />
      </group>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* The way in                                                                   */
/* -------------------------------------------------------------------------- */

/** A row of turnstiles across the runner, glass flaps closed, green lights on. */
function Turnstiles({ x, z, width }: { x: number; z: number; width: number }) {
  const lanes = 3;
  const step = width / lanes;
  return (
    <group position={[x, 0, z]}>
      {Array.from({ length: lanes + 1 }, (_, i) => {
        const px = -width / 2 + i * step;
        return (
          <group key={i} position={[px, 0, 0]}>
            <Block position={[0, 0.5, 0]} size={[0.2, 1, 0.9]} color="#d1d5db" />
            <Block position={[0, 1.01, 0]} size={[0.22, 0.02, 0.92]} color="#1f2937" />
            <Block position={[0, 1.03, -0.3]} size={[0.08, 0.02, 0.08]} color="#22c55e" emissive="#22c55e" emissiveIntensity={1} />
          </group>
        );
      })}
      {Array.from({ length: lanes }, (_, i) => (
        <group key={i} position={[-width / 2 + (i + 0.5) * step, 0.7, 0]}>
          <Block position={[-0.2, 0, 0]} size={[step / 2 - 0.15, 0.4, 0.03]} color="#bfe2f1" opacity={0.5} shadow={false} />
          <Block position={[0.2, 0, 0]} size={[step / 2 - 0.15, 0.4, 0.03]} color="#bfe2f1" opacity={0.5} shadow={false} />
        </group>
      ))}
    </group>
  );
}

/** Visitor seating: a sofa, two armchairs, a low table, a rug. Faces +X. */
function Waiting({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block position={[0.6, 0.032, 0]} size={[3.2, 0.03, 3]} color="#c7d2fe" shadow={false} />
      {/* Sofa. */}
      <Block position={[-0.6, 0.25, 0]} size={[0.85, 0.5, 2.2]} color="#475569" />
      <Block position={[-0.95, 0.65, 0]} size={[0.22, 0.6, 2.2]} color="#334155" />
      <Block position={[-0.6, 0.4, -1.15]} size={[0.85, 0.32, 0.18]} color="#334155" />
      <Block position={[-0.6, 0.4, 1.15]} size={[0.85, 0.32, 0.18]} color="#334155" />
      {/* Coffee table with magazines. */}
      <Block position={[0.55, 0.3, 0]} size={[0.75, 0.06, 1.2]} color="#a16207" />
      <Block position={[0.55, 0.14, 0]} size={[0.65, 0.28, 1.1]} color="#78350f" />
      <Block position={[0.5, 0.35, -0.25]} size={[0.3, 0.02, 0.22]} color="#ef4444" />
      <Block position={[0.6, 0.355, 0.2]} size={[0.3, 0.02, 0.22]} color="#3b82f6" />
      {/* Armchairs across. */}
      {[-0.75, 0.75].map((cz) => (
        <group key={cz} position={[1.75, 0, cz]}>
          <Block position={[0, 0.25, 0]} size={[0.75, 0.5, 0.75]} color="#4359a5" />
          <Block position={[0.32, 0.62, 0]} size={[0.14, 0.55, 0.75]} color="#334e9a" />
        </group>
      ))}
      <Round position={[-0.6, 0.24, 1.75]} radius={0.24} height={0.48} color="#d6d3d1" segments={12} />
      <Block position={[-0.6, 0.72, 1.75]} size={[0.6, 0.55, 0.6]} color="#3f9b54" />
    </group>
  );
}

/** A square lobby column, with a CCTV camera near the top looking at the doors (+Z). */
function Column({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 1.3, 0]} size={[0.5, 2.6, 0.5]} color="#e7e5e4" />
      <Block position={[0, 0.06, 0]} size={[0.6, 0.12, 0.6]} color="#a8a29e" />
      <Block position={[0, 2.56, 0]} size={[0.58, 0.08, 0.58]} color="#a8a29e" />
      <Cctv position={[0, 2.35, 0.27]} />
    </group>
  );
}

function Plant({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Round position={[0, 0.28, 0]} radius={0.28} height={0.56} color="#d6d3d1" segments={12} />
      <Block position={[0, 0.85, 0]} size={[0.65, 0.6, 0.65]} color="#3f9b54" />
      <Block position={[0.05, 1.3, -0.04]} size={[0.45, 0.42, 0.45]} color="#56b86b" />
    </group>
  );
}

export function Lobby({
  x0,
  x1,
  z0,
  z1,
  entranceX,
}: {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  entranceX: number;
}) {
  const welcome = useTextTexture("WELCOME TO VIZSERVE", "#ffffff", 110, 1800, 200);
  const width = x1 - x0;
  const depth = z1 - z0;
  if (width < 8 || depth < 6) return null;

  return (
    <group>
      {/* Lobby carpet, then the runner from the doors with gold edges. */}
      <Block position={[x0 + width / 2, 0.025, z0 + depth / 2]} size={[width - 0.6, 0.03, depth - 0.6]} color="#d9dde6" shadow={false} />
      <Block position={[entranceX, 0.05, z0 + depth / 2 + 0.3]} size={[2.4, 0.02, depth - 0.4]} color={RUNNER} shadow={false} />
      {[-1.16, 1.16].map((dx) => (
        <Block key={dx} position={[entranceX + dx, 0.062, z0 + depth / 2 + 0.3]} size={[0.06, 0.005, depth - 0.4]} color="#d4a017" shadow={false} />
      ))}
      <group position={[entranceX, 0.066, z1 - 1.9]} rotation={[-Math.PI / 2, 0, 0]}>
        <Picture texture={welcome} w={2.1} h={0.24} />
      </group>

      <Turnstiles x={entranceX} z={z1 - 3.6} width={3.6} />
      <SecurityDesk x={entranceX + 3.3} z={z1 - 2.4} />
      <Waiting x={entranceX - 5} z={z1 - 2.6} />
      <Column x={entranceX - 2.4} z={z0 + 1.4} />
      <Column x={entranceX + 2.4} z={z0 + 1.4} />
      <Plant x={entranceX - 2.6} z={z1 - 0.7} />
      <Plant x={entranceX + 2.6} z={z1 - 0.7} />
    </group>
  );
}
