"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Mesh } from "three";

import { Block, Round } from "./office-block";

/**
 * The working furniture of the virtual office: what each department room has
 * besides desks — a printer, a water dispenser, a meeting corner with a
 * projector — and the canteen in the lounge.
 */

const BRAND = "#4359a5";

/* -------------------------------------------------------------------------- */
/* In every room                                                                */
/* -------------------------------------------------------------------------- */

export function Printer({ x, z }: { x: number; z: number }) {
  const light = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (light.current) light.current.visible = Math.floor(clock.elapsedTime * 2) % 3 !== 0;
  });
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.35, 0]} size={[0.9, 0.7, 0.65]} color="#9ca3af" />
      <Block position={[0, 0.85, 0]} size={[0.85, 0.3, 0.6]} color="#e5e7eb" />
      <Block position={[0, 1.02, -0.05]} size={[0.6, 0.04, 0.4]} color="#4b5563" />
      <Block position={[0, 0.78, 0.33]} size={[0.5, 0.03, 0.12]} color="#ffffff" />
      <Block position={[0.32, 0.92, 0.31]} size={[0.16, 0.1, 0.02]} color="#1f2937" shadow={false} />
      <mesh ref={light} position={[0.32, 0.92, 0.323]}>
        <boxGeometry args={[0.04, 0.04, 0.01]} />
        <meshStandardMaterial color="#22c55e" emissive="#22c55e" emissiveIntensity={1} />
      </mesh>
      {[0.2, 0.48].map((y) => (
        <Block key={y} position={[0, y, 0.33]} size={[0.7, 0.02, 0.02]} color="#6b7280" shadow={false} />
      ))}
    </group>
  );
}

export function WaterDispenser({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.5, 0]} size={[0.42, 1, 0.42]} color="#f1f5f9" />
      <Round position={[0, 1.25, 0]} radius={0.17} height={0.5} color="#93c5fd" segments={12} />
      <Block position={[-0.08, 0.75, 0.22]} size={[0.06, 0.06, 0.04]} color="#3b82f6" shadow={false} />
      <Block position={[0.08, 0.75, 0.22]} size={[0.06, 0.06, 0.04]} color="#ef4444" shadow={false} />
    </group>
  );
}

/** A chair facing −Z in its own frame; turn it with `rotation`. */
function Chair({ x, z, rotation = 0, color = "#3e4757" }: { x: number; z: number; rotation?: number; color?: string }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      <Block position={[0, 0.45, 0]} size={[0.48, 0.07, 0.48]} color={color} />
      <Block position={[0, 0.74, 0.22]} size={[0.48, 0.52, 0.06]} color={color} />
      <Block position={[0, 0.22, 0]} size={[0.06, 0.44, 0.06]} color="#1f2937" />
      <Block position={[0, 0.03, 0]} size={[0.4, 0.04, 0.4]} color="#1f2937" />
    </group>
  );
}

/**
 * The meeting corner: a projector on a cart throwing light at the screen on
 * the right wall (`screenX`), and a table with four chairs between them.
 */
export function MeetingCorner({ x, z, screenX }: { x: number; z: number; screenX: number }) {
  const lens = x + 0.42;
  const throwLength = screenX - lens;
  return (
    <group>
      {/* Projector cart. */}
      <group position={[x + 0.2, 0, z]}>
        <Block position={[0, 0.4, 0]} size={[0.5, 0.06, 0.5]} color="#374151" />
        <Block position={[0, 0.2, 0]} size={[0.06, 0.4, 0.06]} color="#374151" />
        <Block position={[0, 0.03, 0]} size={[0.45, 0.04, 0.45]} color="#374151" />
        <Block position={[0, 0.85, 0]} size={[0.06, 0.8, 0.06]} color="#374151" />
        <Block position={[0, 1.3, 0]} size={[0.4, 0.16, 0.34]} color="#f8fafc" />
        <mesh position={[0.21, 1.3, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.06, 0.06, 0.04, 10]} />
          <meshStandardMaterial color="#93c5fd" emissive="#bfdbfe" emissiveIntensity={1} />
        </mesh>
      </group>
      {/* The beam: a faint wedge of light from the lens to the screen. */}
      <mesh position={[lens + throwLength / 2, 1.3, z]} rotation={[0, 0, Math.PI / 2]}>
        <coneGeometry args={[0.7, throwLength, 4, 1, true]} />
        <meshBasicMaterial color="#e0f2fe" transparent opacity={0.12} depthWrite={false} />
      </mesh>

      {/* Table and chairs, between the projector and the screen. */}
      <group position={[x + 2.3, 0, z]}>
        <Block position={[0, 0.72, 0]} size={[1.6, 0.06, 1]} color="#f5f4f0" />
        <Block position={[0, 0.36, 0]} size={[0.1, 0.72, 0.6]} color="#9ca3af" />
        <Round position={[-0.4, 0.8, 0.1]} radius={0.05} height={0.1} color="#ffffff" segments={10} />
        <Block position={[0.3, 0.76, -0.15]} size={[0.3, 0.02, 0.22]} color="#ffffff" />
        <Chair x={-0.45} z={-0.8} rotation={Math.PI} />
        <Chair x={0.45} z={-0.8} rotation={Math.PI} />
        <Chair x={-0.45} z={0.8} />
        <Chair x={0.45} z={0.8} />
      </group>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* The canteen                                                                  */
/* -------------------------------------------------------------------------- */

/** A chair someone can sit in: where, and which way they face (radians about Y; 0 faces −Z). */
export type Seat = { x: number; z: number; facing: number };

/** The canteen's tables, shared by the drawing and the seating so the two agree. */
function canteenTables(x: number, from: number, to: number): { x: number; z: number }[] {
  const span = to - from;
  if (span < 3) return [];
  // Four rows of two tables at most: 32 seats, enough for a team of about 20.
  const rows = Math.min(4, Math.max(1, Math.floor((span - 0.6) / 2.4)));
  return Array.from({ length: rows }, (_, row) => [x + 1.6, x + 4.1].map((tx) => ({ x: tx, z: from + 1.4 + row * 2.4 }))).flat();
}

/** Every canteen chair, for lunch. Four per table, facing it. */
export function canteenSeats(x: number, from: number, to: number): Seat[] {
  return canteenTables(x, from, to).flatMap((t) => [
    { x: t.x - 0.35, z: t.z - 0.75, facing: Math.PI },
    { x: t.x + 0.35, z: t.z - 0.75, facing: Math.PI },
    { x: t.x - 0.35, z: t.z + 0.75, facing: 0 },
    { x: t.x + 0.35, z: t.z + 0.75, facing: 0 },
  ]);
}

/**
 * The canteen, filling the lounge between `from` and `to` along Z: a kitchen
 * counter against the right wall (fridge, microwave, kettle, sink) and rows of
 * four-seat dining tables. Draws nothing if there is no room for a table.
 */
export function Canteen({ x, width, from, to }: { x: number; width: number; from: number; to: number }) {
  const span = to - from;
  if (span < 3) return null;
  const right = x + width;
  const tables = canteenTables(x, from, to);
  const counter = Math.min(span, 5.5) - 0.4;

  return (
    <group>
      {/* Its own floor colour, so the canteen reads as its own place — plain, no tile lines to shimmer. */}
      <Block position={[x + width / 2, 0.035, from + span / 2]} size={[width - 0.6, 0.04, span - 0.2]} color="#e7e5e4" shadow={false} />

      {/* Kitchen counter along the right wall. */}
      <group position={[right - 0.5, 0, from + 0.9 + counter / 2]}>
        <Block position={[0, 0.48, 0]} size={[0.65, 0.96, counter]} color="#f8fafc" />
        <Block position={[0, 0.98, 0]} size={[0.72, 0.05, counter + 0.1]} color="#78716c" />
        {/* Fridge at the near end. */}
        <Block position={[0, 1, -counter / 2 - 0.42]} size={[0.75, 2, 0.8]} color="#e2e8f0" />
        <Block position={[-0.38, 1.25, -counter / 2 - 0.15]} size={[0.02, 0.5, 0.05]} color="#64748b" shadow={false} />
        {/* Microwave, kettle, sink. */}
        <Block position={[0, 1.15, -counter / 2 + 0.6]} size={[0.5, 0.3, 0.6]} color="#1f2937" />
        <Block position={[-0.26, 1.15, -counter / 2 + 0.55]} size={[0.01, 0.2, 0.35]} color="#38bdf8" emissive="#0ea5e9" emissiveIntensity={0.4} shadow={false} />
        <Round position={[0, 1.1, 0]} radius={0.1} height={0.2} color="#ef4444" segments={10} />
        <Block position={[0, 1.005, counter / 2 - 0.6]} size={[0.5, 0.02, 0.6]} color="#cbd5e1" shadow={false} />
        <Block position={[0.15, 1.15, counter / 2 - 0.6]} size={[0.04, 0.3, 0.04]} color="#9ca3af" />
        {/* Wall cabinets over it. */}
        <Block position={[0.12, 1.9, 0]} size={[0.4, 0.6, counter - 0.2]} color="#f1f5f9" />
      </group>

      {/* Dining tables. */}
      {tables.map((table, i) => (
          <group key={i} position={[table.x, 0, table.z]}>
            <Block position={[0, 0.74, 0]} size={[1.4, 0.06, 0.9]} color="#fafaf9" />
            <Block position={[-0.6, 0.36, 0]} size={[0.06, 0.72, 0.7]} color="#a8a29e" />
            <Block position={[0.6, 0.36, 0]} size={[0.06, 0.72, 0.7]} color="#a8a29e" />
            {i % 3 === 0 ? (
              <>
                <Block position={[-0.3, 0.78, -0.2]} size={[0.3, 0.02, 0.24]} color="#ffffff" />
                <Round position={[0.3, 0.82, 0.15]} radius={0.05} height={0.12} color={BRAND} segments={10} />
              </>
            ) : (
              <Round position={[0, 0.84, 0]} radius={0.08} height={0.14} color="#22c55e" segments={10} />
            )}
            <Chair x={-0.35} z={-0.75} rotation={Math.PI} color="#d97706" />
            <Chair x={0.35} z={-0.75} rotation={Math.PI} color="#d97706" />
            <Chair x={-0.35} z={0.75} color="#d97706" />
            <Chair x={0.35} z={0.75} color="#d97706" />
          </group>
      ))}
    </group>
  );
}
