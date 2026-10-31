"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { MeshStandardMaterial } from "three";

import { Block, Round } from "./office-block";

/**
 * The breakout area — the stretch of the lounge between the gym and the sofa
 * corner, filled with places to sit rather than left as floor. Two to a row:
 *
 *   1. a co-working bar with stools and laptops, beside a game corner
 *      (foosball and an arcade cabinet);
 *   2. bean bags round a low table, beside a reading nook (a full bookshelf,
 *      two armchairs, a lamp);
 *   3. a row of massage chairs.
 *
 * As many rows as fit, and none if there is no room. `x … x + width` by
 * `from … to` is its floor.
 */

const BRAND = "#4359a5";
const ROW = 3.4;

function Stool({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Round position={[0, 0.02, 0]} radius={0.17} height={0.04} color="#374151" segments={12} />
      <Block position={[0, 0.36, 0]} size={[0.05, 0.7, 0.05]} color="#374151" />
      <Round position={[0, 0.72, 0]} radius={0.19} height={0.07} color={BRAND} segments={12} />
    </group>
  );
}

/** A long high table, stools both sides, laptops open. Along X. */
function CoworkingBar({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 1.0, 0]} size={[3.2, 0.06, 0.9]} color="#a16207" />
      {[-1.4, 1.4].map((lx) => (
        <Block key={lx} position={[lx, 0.5, 0]} size={[0.08, 1, 0.7]} color="#1f2937" />
      ))}
      {[-1.05, 0, 1.05].map((sx) =>
        [-0.75, 0.75].map((sz) => <Stool key={`${sx}${sz}`} x={sx} z={sz} />),
      )}
      {/* Laptops, lids up, facing the stools on the near side. */}
      {[-1.05, 0, 1.05].map((lx, i) => (
        <group key={lx} position={[lx, 1.04, 0.15]}>
          <Block position={[0, 0.01, 0]} size={[0.36, 0.02, 0.25]} color="#d1d5db" />
          <Block position={[0, 0.13, -0.12]} size={[0.36, 0.24, 0.015]} color="#d1d5db" rotation={[-0.25, 0, 0]} />
          <Block
            position={[0, 0.13, -0.11]}
            size={[0.32, 0.2, 0.005]}
            color={i === 1 ? "#a7f3d0" : "#bfdbfe"}
            emissive={i === 1 ? "#6ee7b7" : "#93c5fd"}
            emissiveIntensity={0.5}
            rotation={[-0.25, 0, 0]}
            shadow={false}
          />
        </group>
      ))}
      <Round position={[-0.5, 1.09, -0.25]} radius={0.05} height={0.12} color="#ffffff" segments={10} />
      <group position={[0.5, 1.03, -0.25]}>
        <Round position={[0, 0.06, 0]} radius={0.07} height={0.12} color="#b5672c" segments={10} />
        <Block position={[0, 0.2, 0]} size={[0.16, 0.16, 0.16]} color="#4caf50" />
      </group>
    </group>
  );
}

/** A foosball table: green field, rods across, little red and blue players. */
function Foosball({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.78, 0]} size={[0.8, 0.2, 1.4]} color="#78350f" />
      <Block position={[0, 0.885, 0]} size={[0.7, 0.01, 1.3]} color="#16a34a" shadow={false} />
      {[-0.3, 0.3].map((lx) =>
        [-0.6, 0.6].map((lz) => <Block key={`${lx}${lz}`} position={[lx, 0.34, lz]} size={[0.08, 0.68, 0.08]} color="#78350f" />),
      )}
      {[-0.45, -0.15, 0.15, 0.45].map((rz, i) => (
        <group key={rz} position={[0, 0.95, rz]}>
          <Block position={[0, 0, 0]} size={[1.2, 0.025, 0.025]} color="#d1d5db" shadow={false} />
          {[-0.2, 0, 0.2].map((px) => (
            <Block key={px} position={[px, -0.04, 0]} size={[0.05, 0.1, 0.04]} color={i % 2 ? "#2563eb" : "#dc2626"} />
          ))}
        </group>
      ))}
    </group>
  );
}

/** An arcade cabinet; its screen cycles colours. Faces +Z. */
function Arcade({ x, z }: { x: number; z: number }) {
  const screen = useRef<MeshStandardMaterial>(null);
  const colors = ["#22d3ee", "#a855f7", "#f472b6", "#facc15"];
  useFrame(({ clock }) => {
    const c = colors[Math.floor(clock.elapsedTime / 0.8) % colors.length];
    screen.current?.emissive.set(c);
    screen.current?.color.set(c);
  });
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.85, 0]} size={[0.7, 1.7, 0.7]} color="#1e1b4b" />
      <Block position={[0, 1.78, 0.05]} size={[0.72, 0.2, 0.62]} color="#312e81" emissive="#6366f1" emissiveIntensity={0.6} />
      <mesh position={[0, 1.3, 0.31]}>
        <boxGeometry args={[0.5, 0.4, 0.02]} />
        <meshStandardMaterial ref={screen} color={colors[0]} emissive={colors[0]} emissiveIntensity={0.7} />
      </mesh>
      <Block position={[0, 0.95, 0.4]} size={[0.66, 0.08, 0.3]} color="#111827" rotation={[0.3, 0, 0]} />
      <Block position={[-0.15, 1.04, 0.42]} size={[0.04, 0.1, 0.04]} color="#ef4444" />
      {[0.05, 0.15, 0.25].map((bx) => (
        <Round key={bx} position={[bx, 1.0, 0.44]} radius={0.025} height={0.02} color={bx > 0.2 ? "#22c55e" : "#facc15"} segments={8} />
      ))}
    </group>
  );
}

/** A bean bag: a squashed ball. */
function BeanBag({ x, z, color }: { x: number; z: number; color: string }) {
  return (
    <mesh position={[x, 0.25, z]} scale={[1, 0.6, 1]} castShadow receiveShadow>
      <sphereGeometry args={[0.42, 14, 10]} />
      <meshStandardMaterial color={color} flatShading roughness={0.9} />
    </mesh>
  );
}

/** Four bean bags round a low table of snacks, on a round rug. */
function ChillZone({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.075, 0]} receiveShadow>
        <cylinderGeometry args={[1.5, 1.5, 0.02, 24]} />
        <meshStandardMaterial color="#fde68a" />
      </mesh>
      <BeanBag x={-0.95} z={-0.5} color="#f97316" />
      <BeanBag x={0.95} z={-0.5} color="#8b5cf6" />
      <BeanBag x={-0.95} z={0.6} color="#06b6d4" />
      <BeanBag x={0.95} z={0.6} color="#ec4899" />
      <Round position={[0, 0.22, 0.05]} radius={0.38} height={0.06} color="#f5f5f4" segments={16} />
      <Round position={[0, 0.1, 0.05]} radius={0.06} height={0.2} color="#9ca3af" segments={8} />
      <Block position={[-0.1, 0.27, 0]} size={[0.18, 0.04, 0.12]} color="#ef4444" />
      <Round position={[0.12, 0.29, 0.12]} radius={0.06} height={0.08} color="#facc15" segments={10} />
    </group>
  );
}

/** A reading nook: a tall full bookshelf, two armchairs, a side table and lamp. Faces +Z. */
function ReadingNook({ x, z }: { x: number; z: number }) {
  const books = ["#dc2626", "#2563eb", "#16a34a", "#ca8a04", "#7c3aed", "#db2777", "#0891b2"];
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 1, -1]} size={[2.6, 2, 0.4]} color="#6d4c2f" />
      {[0.35, 0.85, 1.35, 1.8].flatMap((y, row) =>
        Array.from({ length: 10 }, (_, i) => (
          <Block
            key={`${y}-${i}`}
            position={[-1.1 + i * 0.245, y, -0.78]}
            size={[0.18, 0.32 + ((i + row) % 3) * 0.04, 0.04]}
            color={books[(i + row * 3) % books.length]}
            shadow={false}
          />
        )),
      )}
      {[-0.65, 0.65].map((ax, i) => (
        <group key={ax} position={[ax, 0, 0.1]} rotation={[0, i ? -0.35 : 0.35, 0]}>
          <Block position={[0, 0.25, 0]} size={[0.75, 0.5, 0.75]} color="#0f766e" />
          <Block position={[0, 0.65, -0.32]} size={[0.75, 0.6, 0.14]} color="#115e59" />
          <Block position={[-0.36, 0.45, 0]} size={[0.1, 0.25, 0.75]} color="#115e59" />
          <Block position={[0.36, 0.45, 0]} size={[0.1, 0.25, 0.75]} color="#115e59" />
        </group>
      ))}
      <Round position={[0, 0.3, 0.05]} radius={0.22} height={0.04} color="#a16207" segments={12} />
      <Block position={[0, 0.15, 0.05]} size={[0.06, 0.3, 0.06]} color="#78350f" />
      <Block position={[0, 0.5, 0.05]} size={[0.03, 0.36, 0.03]} color="#374151" />
      <Round position={[0, 0.72, 0.05]} radius={0.14} height={0.16} color="#fef3c7" emissive="#fde68a" emissiveIntensity={0.6} segments={10} />
    </group>
  );
}

/** A massage chair, reclined, leg rest out, remote glowing on the arm. Faces +Z. */
function MassageChair({ x, z }: { x: number; z: number }) {
  const leather = "#3f2a1d";
  const trim = "#57534e";
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.12, 0]} size={[0.8, 0.24, 1.1]} color={trim} />
      <Block position={[0, 0.42, 0]} size={[0.62, 0.22, 0.7]} color={leather} />
      {/* Backrest, tipped back. */}
      <Block position={[0, 0.88, -0.42]} size={[0.62, 0.9, 0.22]} color={leather} rotation={[-0.45, 0, 0]} />
      <Block position={[0, 1.3, -0.62]} size={[0.5, 0.22, 0.2]} color={leather} rotation={[-0.45, 0, 0]} />
      {/* Leg rest, angled down from the seat. */}
      <Block position={[0, 0.3, 0.5]} size={[0.55, 0.16, 0.5]} color={leather} rotation={[0.55, 0, 0]} />
      {/* Big padded arms, a remote on one. */}
      {[-0.38, 0.38].map((ax) => (
        <Block key={ax} position={[ax, 0.6, -0.05]} size={[0.18, 0.4, 0.85]} color={trim} />
      ))}
      <Block position={[0.38, 0.81, 0.15]} size={[0.1, 0.03, 0.16]} color="#111827" />
      <Block position={[0.38, 0.83, 0.15]} size={[0.06, 0.005, 0.08]} color="#38bdf8" emissive="#38bdf8" emissiveIntensity={0.8} shadow={false} />
    </group>
  );
}

/** Massage chairs in a row across the lounge, a plant at each end. */
function Wellness({ left, right, z }: { left: number; right: number; z: number }) {
  const xs = [left - 0.6, left + 0.6, right - 0.6, right + 0.6];
  return (
    <group>
      {xs.map((cx) => (
        <MassageChair key={cx} x={cx} z={z} />
      ))}
      {[xs[0] - 1, xs[3] + 1].map((px) => (
        <group key={px} position={[px, 0, z - 0.2]}>
          <Round position={[0, 0.22, 0]} radius={0.22} height={0.44} color="#d6d3d1" segments={12} />
          <Block position={[0, 0.66, 0]} size={[0.5, 0.48, 0.5]} color="#3f9b54" />
        </group>
      ))}
    </group>
  );
}

export function Breakout({ x, width, from, to }: { x: number; width: number; from: number; to: number }) {
  const rows = Math.min(3, Math.floor((to - from) / ROW));
  if (rows < 1) return null;
  const left = x + width * 0.3;
  const right = x + width * 0.75;
  const rowZ = (row: number) => from + ROW * row + ROW / 2;
  // The massage chairs need less depth than a full row (about 1.2), so they
  // also take a leftover band too short for one.
  const leftover = to - from - ROW * 2;
  const restZ = rows >= 3 ? rowZ(2) : rows === 2 && leftover >= 1.6 ? from + ROW * 2 + leftover / 2 : null;

  return (
    <group>
      {/* Row one: work, and play. */}
      <CoworkingBar x={left} z={rowZ(0)} />
      <Foosball x={right - 0.6} z={rowZ(0)} />
      <Arcade x={right + 0.9} z={rowZ(0) - 0.4} />

      {/* Row two: somewhere soft, and somewhere quiet. */}
      {rows >= 2 ? (
        <>
          <ChillZone x={left} z={rowZ(1)} />
          <ReadingNook x={right + 0.2} z={rowZ(1) + 0.3} />
        </>
      ) : null}

      {/* Row three: a rest — massage chairs. */}
      {restZ !== null ? <Wellness left={left} right={right + 0.2} z={restZ} /> : null}
    </group>
  );
}
