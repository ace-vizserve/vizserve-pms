"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group, Mesh } from "three";

import { Block } from "./office-block";

/* -------------------------------------------------------------------------- */
/* CCTV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A CCTV camera on a wall bracket, slowly panning, its red light blinking.
 * Mounted at `position`, looking along +Z in its own frame — turn it with
 * `facing` (radians about Y).
 */
export function Cctv({ position, facing = 0 }: { position: [number, number, number]; facing?: number }) {
  const head = useRef<Group>(null);
  const led = useRef<Mesh>(null);
  const phase = (position[0] * 7 + position[2] * 3) % 6;
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + phase;
    if (head.current) head.current.rotation.y = Math.sin(t * 0.35) * 0.6;
    if (led.current) led.current.visible = Math.floor(t * 1.5) % 2 === 0;
  });
  return (
    <group position={position} rotation={[0, facing, 0]}>
      <Block position={[0, 0, -0.06]} size={[0.14, 0.14, 0.04]} color="#e5e7eb" />
      <Block position={[0, -0.06, 0.02]} size={[0.04, 0.12, 0.04]} color="#9ca3af" />
      <group ref={head} position={[0, -0.14, 0.04]}>
        <group rotation={[0.35, 0, 0]}>
          <Block position={[0, 0, 0.1]} size={[0.14, 0.12, 0.3]} color="#f8fafc" />
          <Block position={[0, 0.07, 0.12]} size={[0.18, 0.02, 0.36]} color="#d1d5db" />
          <mesh position={[0, 0, 0.26]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.045, 0.045, 0.03, 12]} />
            <meshStandardMaterial color="#111827" />
          </mesh>
          <mesh ref={led} position={[0.05, 0.04, 0.255]}>
            <boxGeometry args={[0.02, 0.02, 0.01]} />
            <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={1.2} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

