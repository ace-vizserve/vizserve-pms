"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";

import { Block, Round } from "./office-block";
import { Sign } from "./office-sign";

/**
 * The gym, in the lounge between the canteen and the sofa corner: two
 * treadmills, two exercise bikes, a bench press, a dumbbell rack, kettlebells
 * and a ball, on a rubber mat. `x … x + width` by `from … to` is its floor.
 */

const FRAME = "#374151";
const MAT = "#3f3f46";

function Treadmill({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      {/* Deck and belt, running along Z; the console at the far (−Z) end. */}
      <Block position={[0, 0.12, 0]} size={[0.75, 0.16, 1.8]} color={FRAME} />
      <Block position={[0, 0.21, 0.05]} size={[0.55, 0.02, 1.55]} color="#111827" shadow={false} />
      {[-0.36, 0.36].map((side) => (
        <group key={side}>
          <Block position={[side, 0.75, -0.7]} size={[0.06, 1.1, 0.06]} color={FRAME} />
          <Block position={[side, 1.0, -0.45]} size={[0.05, 0.05, 0.55]} color="#9ca3af" />
        </group>
      ))}
      <Block position={[0, 1.3, -0.72]} size={[0.78, 0.32, 0.12]} color="#1f2937" />
      <Block position={[0, 1.3, -0.655]} size={[0.5, 0.2, 0.01]} color="#38bdf8" emissive="#0ea5e9" emissiveIntensity={0.6} shadow={false} />
    </group>
  );
}

/** An exercise bike; its flywheel turns. Faces −Z. */
function Bike({ x, z }: { x: number; z: number }) {
  const wheel = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (wheel.current) wheel.current.rotation.x = clock.elapsedTime * 3;
  });
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.04, 0]} size={[0.5, 0.08, 1.1]} color={FRAME} />
      {/* Frame: down tube to the seat, up to the bars. */}
      <Block position={[0, 0.45, 0.25]} size={[0.07, 0.8, 0.07]} color={FRAME} rotation={[0.25, 0, 0]} />
      <Block position={[0, 0.88, 0.32]} size={[0.26, 0.07, 0.34]} color="#111827" />
      <Block position={[0, 0.6, -0.3]} size={[0.07, 1.1, 0.07]} color={FRAME} rotation={[-0.2, 0, 0]} />
      <Block position={[0, 1.12, -0.42]} size={[0.5, 0.05, 0.06]} color="#9ca3af" />
      <Block position={[0, 1.15, -0.38]} size={[0.2, 0.12, 0.08]} color="#1f2937" />
      {/* Flywheel. */}
      <group ref={wheel} position={[0, 0.35, -0.38]}>
        <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.24, 0.24, 0.08, 16]} />
          <meshStandardMaterial color="#dc2626" flatShading />
        </mesh>
        <Block position={[0, 0.18, 0]} size={[0.09, 0.08, 0.05]} color="#f8fafc" shadow={false} />
      </group>
    </group>
  );
}

/** A flat bench under a rack, the barbell racked with plates on. Along Z. */
function BenchPress({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.42, 0.15]} size={[0.32, 0.1, 1.2]} color="#1f2937" />
      <Block position={[0, 0.2, 0.5]} size={[0.08, 0.4, 0.08]} color={FRAME} />
      <Block position={[0, 0.2, -0.2]} size={[0.08, 0.4, 0.08]} color={FRAME} />
      {/* Rack uprights at the head end. */}
      {[-0.55, 0.55].map((side) => (
        <group key={side}>
          <Block position={[side, 0.65, -0.35]} size={[0.07, 1.3, 0.07]} color={FRAME} />
          <Block position={[side, 0.04, -0.35]} size={[0.3, 0.08, 0.5]} color={FRAME} />
          <Block position={[side * 0.92, 1.0, -0.3]} size={[0.06, 0.06, 0.12]} color="#9ca3af" />
        </group>
      ))}
      {/* The bar and its plates. */}
      <mesh position={[0, 1.05, -0.3]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 1.8, 8]} />
        <meshStandardMaterial color="#d1d5db" />
      </mesh>
      {[-0.78, -0.7, 0.7, 0.78].map((px) => (
        <mesh key={px} position={[px, 1.05, -0.3]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[Math.abs(px) > 0.75 ? 0.17 : 0.22, Math.abs(px) > 0.75 ? 0.17 : 0.22, 0.05, 16]} />
          <meshStandardMaterial color="#111827" flatShading />
        </mesh>
      ))}
    </group>
  );
}

/** A two-tier rack of dumbbells, along X. */
function DumbbellRack({ x, z }: { x: number; z: number }) {
  const colors = ["#dc2626", "#2563eb", "#16a34a", "#f59e0b", "#7c3aed"];
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.3, 0]} size={[2.2, 0.06, 0.45]} color={FRAME} />
      <Block position={[0, 0.65, -0.08]} size={[2.2, 0.06, 0.4]} color={FRAME} />
      {[-1.05, 1.05].map((px) => (
        <Block key={px} position={[px, 0.35, 0]} size={[0.06, 0.7, 0.45]} color={FRAME} />
      ))}
      {[0.38, 0.73].flatMap((y) =>
        colors.map((c, i) => (
          <group key={`${y}-${i}`} position={[-0.85 + i * 0.42, y, y > 0.5 ? -0.08 : 0]}>
            <Block position={[0, 0, 0]} size={[0.24, 0.04, 0.04]} color="#9ca3af" shadow={false} />
            <Block position={[-0.12, 0, 0]} size={[0.06, 0.12, 0.12]} color={c} />
            <Block position={[0.12, 0, 0]} size={[0.06, 0.12, 0.12]} color={c} />
          </group>
        )),
      )}
    </group>
  );
}

export function Gym({ x, width, from, to }: { x: number; width: number; from: number; to: number }) {
  const depth = to - from;
  return (
    <group>
      {/* Rubber mat, and a line marking the training area. */}
      <Block position={[x + width / 2, 0.06, from + depth / 2]} size={[width - 0.6, 0.02, depth]} color={MAT} shadow={false} />
      <Block position={[x + width / 2, 0.072, from + 0.1]} size={[width - 0.6, 0.005, 0.06]} color="#facc15" shadow={false} />

      <Sign position={[x + width / 2, 2.4, from + 0.3]} title="GYM" subtitle="OPEN TO EVERYONE" color="#dc2626" height={0.75} />

      <Treadmill x={x + 1.2} z={from + 1.5} />
      <Treadmill x={x + 2.3} z={from + 1.5} />
      <Bike x={x + 3.7} z={from + 1.3} />
      <Bike x={x + 4.6} z={from + 1.3} />
      <BenchPress x={x + 6.4} z={from + 1.7} />

      <DumbbellRack x={x + 2} z={to - 0.6} />
      {/* Kettlebells and an exercise ball. */}
      {[0, 1, 2].map((i) => (
        <group key={i} position={[x + 4 + i * 0.35, 0, to - 0.7]}>
          <Round position={[0, 0.16, 0]} radius={0.13} height={0.24} color="#111827" segments={10} />
          <Block position={[0, 0.33, 0]} size={[0.16, 0.05, 0.04]} color="#111827" />
        </group>
      ))}
      <mesh position={[x + 6, 0.38, to - 0.9]} castShadow>
        <sphereGeometry args={[0.32, 16, 12]} />
        <meshStandardMaterial color="#38bdf8" flatShading />
      </mesh>
    </group>
  );
}
