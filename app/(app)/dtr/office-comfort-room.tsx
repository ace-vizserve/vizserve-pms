"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";

import { bathroomIsTaken } from "@/lib/office";

import { Block } from "./office-block";
import { Picture, useTextTexture } from "./office-props";

/**
 * The comfort room, at the back end of the main corridor: a door in the back wall
 * that faces down the corridor, with a roofed annex behind the wall. `x` is the
 * corridor's middle, and the annex runs to −Z from the wall. Somebody inside is
 * simply not drawn. The lamp follows the same clock as their turns
 * (`bathroomIsTaken`), so it is red exactly while somebody is in, and `count` is
 * how many people take turns.
 */
export function ComfortRoom({ x, count }: { x: number; count: number }) {
  const sign = useTextTexture("COMFORT ROOM", "#ffffff", 110, 1400, 200);
  const free = useRef<Group>(null);
  const taken = useRef<Group>(null);

  useFrame(({ clock }) => {
    const busy = bathroomIsTaken(clock.elapsedTime, count);
    if (free.current) free.current.visible = !busy;
    if (taken.current) taken.current.visible = busy;
  });

  return (
    <group position={[x, 0, 0]}>
      {/* The annex, behind the back wall. */}
      <Block position={[0, -0.1, -1.7]} size={[2.6, 0.2, 2.8]} color="#d6d3d1" />
      <Block position={[-1.25, 1, -1.7]} size={[0.1, 2, 2.8]} color="#e7e5e4" />
      <Block position={[1.25, 1, -1.7]} size={[0.1, 2, 2.8]} color="#e7e5e4" />
      <Block position={[0, 1, -3.05]} size={[2.6, 2, 0.1]} color="#e7e5e4" />
      <Block position={[0, 2.05, -1.7]} size={[2.8, 0.1, 3]} color="#a8a29e" />

      {/* The door, on the corridor's side of the wall, with its sign and lamp. */}
      <Block position={[-0.56, 1.05, 0.05]} size={[0.08, 2.1, 0.1]} color="#475569" />
      <Block position={[0.56, 1.05, 0.05]} size={[0.08, 2.1, 0.1]} color="#475569" />
      <Block position={[0, 2.12, 0.05]} size={[1.2, 0.08, 0.1]} color="#475569" />
      <Block position={[0, 1.02, 0.04]} size={[1.04, 2.04, 0.06]} color="#0f766e" />
      <Block position={[0.38, 1, 0.09]} size={[0.06, 0.2, 0.04]} color="#d1d5db" />
      <Block position={[0, 1.6, 0.08]} size={[0.92, 0.2, 0.02]} color="#134e4a" shadow={false} />
      <group position={[0, 1.6, 0.095]}>
        <Picture texture={sign} w={0.84} h={0.13} />
      </group>
      <group ref={free} position={[0, 1.85, 0.09]}>
        <Block position={[0, 0, 0]} size={[0.14, 0.08, 0.04]} color="#22c55e" emissive="#22c55e" emissiveIntensity={1} shadow={false} />
      </group>
      <group ref={taken} position={[0, 1.85, 0.09]} visible={false}>
        <Block position={[0, 0, 0]} size={[0.14, 0.08, 0.04]} color="#ef4444" emissive="#ef4444" emissiveIntensity={1} shadow={false} />
      </group>
    </group>
  );
}
