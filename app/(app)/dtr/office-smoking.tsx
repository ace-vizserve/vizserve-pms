"use client";

import { Block } from "./office-block";
import { Picture, useTextTexture } from "./office-props";

/**
 * The smoking area — a concrete pad outside the fire exit, in the open air and
 * off the floor plan. `x` is the outside face of the building's wall and `z` the
 * door, so somebody walking straight out of the fire exit lands on it. Smokers are
 * `isSmoker` in lib/office.ts.
 */
export function SmokingArea({ x, z }: { x: number; z: number }) {
  const sign = useTextTexture("SMOKING AREA", "#ffffff", 110, 1400, 200);

  return (
    <group position={[x, 0, z]}>
      <Block position={[1.45, -0.1, 0]} size={[2.6, 0.2, 3.4]} color="#a8a29e" />

      {/* A rail round the three open sides. */}
      <Block position={[2.72, 0.55, 0]} size={[0.05, 0.05, 3.4]} color="#57534e" />
      <Block position={[1.45, 0.55, -1.68]} size={[2.6, 0.05, 0.05]} color="#57534e" />
      <Block position={[1.45, 0.55, 1.68]} size={[2.6, 0.05, 0.05]} color="#57534e" />
      {[
        [2.72, -1.68],
        [2.72, 0],
        [2.72, 1.68],
        [0.2, -1.68],
        [0.2, 1.68],
      ].map(([px, pz]) => (
        <Block key={`${px},${pz}`} position={[px, 0.28, pz]} size={[0.05, 0.55, 0.05]} color="#57534e" />
      ))}

      {/* The sign, on a post at the pad's back corner. */}
      <group position={[0.6, 0, -1.4]}>
        <Block position={[0, 0.8, 0]} size={[0.06, 1.6, 0.06]} color="#44403c" />
        <Block position={[0, 1.7, 0.02]} size={[1.1, 0.26, 0.03]} color="#b91c1c" />
        <group position={[0, 1.7, 0.04]}>
          <Picture texture={sign} w={1} h={0.16} />
        </group>
      </group>

      {/* The bin with its ashtray top, and a bench. */}
      <Block position={[2.2, 0.35, -1.1]} size={[0.3, 0.7, 0.3]} color="#374151" />
      <Block position={[2.2, 0.72, -1.1]} size={[0.34, 0.04, 0.34]} color="#9ca3af" />
      <Block position={[2.35, 0.4, 1]} size={[0.45, 0.06, 1.2]} color="#78350f" />
      <Block position={[2.35, 0.2, 0.55]} size={[0.4, 0.4, 0.06]} color="#44403c" />
      <Block position={[2.35, 0.2, 1.45]} size={[0.4, 0.4, 0.06]} color="#44403c" />
    </group>
  );
}
