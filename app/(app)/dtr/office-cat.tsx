"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";

import { Block } from "./office-block";

/**
 * The office cat — an orange tabby that wanders the whole floor. It walks the
 * corridors, goes in through each department's door and has a look round,
 * and stays longer at the canteen and the gym. Whenever it stops it sits down,
 * tail going.
 *
 * Its day is one loop, worked out once from the floor plan: for each stop it
 * walks along the main corridor to that stop's junction, follows the stop's
 * route in, sits for `stay` seconds, and walks the route back out. Routes keep
 * to corridors and doorways, so it never walks through a wall. Where it is at
 * any moment comes from the clock, so it costs no re-render.
 */

export type Point = [number, number];

/** A place the cat visits: `route[0]` is on the main corridor, the last point is where it sits. */
export type CatStop = { route: Point[]; stay: number };

type Leg = { from: Point; to: Point; start: number; end: number } | { at: Point; start: number; end: number; facing: number };

/** Walking speed, units a second. */
const SPEED = 1.1;

function timeline(stops: CatStop[]): { legs: Leg[]; total: number } {
  const legs: Leg[] = [];
  let t = 0;
  const walk = (from: Point, to: Point) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (length < 0.01) return;
    legs.push({ from, to, start: t, end: t + length / SPEED });
    t += length / SPEED;
  };

  let here: Point | null = null;
  for (const stop of stops) {
    if (stop.route.length === 0) continue;
    if (here) walk(here, stop.route[0]);
    for (let i = 1; i < stop.route.length; i++) walk(stop.route[i - 1], stop.route[i]);
    const last = stop.route[stop.route.length - 1];
    const prev = stop.route[stop.route.length - 2] ?? last;
    legs.push({ at: last, start: t, end: t + stop.stay, facing: Math.atan2(-(last[0] - prev[0]), -(last[1] - prev[1])) });
    t += stop.stay;
    for (let i = stop.route.length - 1; i > 0; i--) walk(stop.route[i], stop.route[i - 1]);
    here = stop.route[0];
  }
  // Back to the first junction, to close the loop.
  if (here && stops[0]?.route[0]) walk(here, stops[0].route[0]);
  return { legs, total: t };
}

export function Cat({ stops }: { stops: CatStop[] }) {
  const { legs, total } = useMemo(() => timeline(stops), [stops]);

  const root = useRef<Group>(null);
  const body = useRef<Group>(null);
  const tail = useRef<Group>(null);
  const feet = useRef<(Group | null)[]>([]);

  useFrame(({ clock }) => {
    if (!root.current || !body.current || total <= 0) return;
    const time = clock.elapsedTime;
    const t = time % total;
    const leg = legs.find((candidate) => t >= candidate.start && t < candidate.end) ?? legs[legs.length - 1];
    if (!leg) return;

    let walking = false;
    if ("from" in leg) {
      const k = (t - leg.start) / (leg.end - leg.start);
      const x = leg.from[0] + (leg.to[0] - leg.from[0]) * k;
      const z = leg.from[1] + (leg.to[1] - leg.from[1]) * k;
      root.current.position.set(x, 0, z);
      root.current.rotation.y = Math.atan2(-(leg.to[0] - leg.from[0]), -(leg.to[1] - leg.from[1]));
      walking = true;
    } else {
      root.current.position.set(leg.at[0], 0, leg.at[1]);
      root.current.rotation.y = leg.facing;
    }

    // Walking: a trot, diagonal pairs together, a little bob. Stopped: sitting.
    const step = Math.sin(time * 12) * 0.6;
    feet.current.forEach((foot, i) => {
      if (!foot) return;
      foot.rotation.x = walking ? (i === 0 || i === 3 ? step : -step) : 0;
      foot.visible = walking || i < 2;
    });
    body.current.position.y = walking ? Math.abs(Math.sin(time * 12)) * 0.015 : -0.1;
    body.current.rotation.x = walking ? 0 : -0.35;
    if (tail.current) tail.current.rotation.y = Math.sin(time * (walking ? 6 : 2.5)) * (walking ? 0.25 : 0.5);
  });

  const fur = "#f08a3c";
  const stripe = "#c2611f";
  return (
    <group ref={root}>
      {/* Legs, hanging from the hips; the cat faces −Z. */}
      {(
        [
          [-0.08, -0.18],
          [0.08, -0.18],
          [-0.08, 0.18],
          [0.08, 0.18],
        ] as const
      ).map(([lx, lz], i) => (
        <group
          key={i}
          position={[lx, 0.2, lz]}
          ref={(node) => {
            feet.current[i] = node;
          }}
        >
          <Block position={[0, -0.1, 0]} size={[0.07, 0.2, 0.07]} color={fur} />
          <Block position={[0, -0.19, -0.01]} size={[0.08, 0.03, 0.09]} color="#ffffff" />
        </group>
      ))}

      <group ref={body}>
        {/* Body, stripes, a white chest. */}
        <Block position={[0, 0.28, 0]} size={[0.24, 0.2, 0.55]} color={fur} />
        {[-0.15, 0, 0.15].map((sz) => (
          <Block key={sz} position={[0, 0.385, sz]} size={[0.25, 0.02, 0.06]} color={stripe} shadow={false} />
        ))}
        <Block position={[0, 0.25, -0.27]} size={[0.16, 0.12, 0.03]} color="#ffffff" shadow={false} />

        {/* Head: ears, eyes, muzzle, nose. */}
        <group position={[0, 0.42, -0.33]}>
          <Block position={[0, 0, 0]} size={[0.26, 0.22, 0.22]} color={fur} />
          {[-0.08, 0.08].map((ex) => (
            <group key={ex}>
              <Block position={[ex, 0.14, 0]} size={[0.07, 0.08, 0.05]} color={fur} />
              <Block position={[ex, 0.135, -0.026]} size={[0.035, 0.05, 0.01]} color="#f9a8d4" shadow={false} />
              <Block position={[ex * 0.75, 0.03, -0.115]} size={[0.04, 0.04, 0.01]} color="#111827" shadow={false} />
            </group>
          ))}
          <Block position={[0, -0.05, -0.115]} size={[0.12, 0.07, 0.02]} color="#ffffff" shadow={false} />
          <Block position={[0, -0.02, -0.125]} size={[0.035, 0.025, 0.01]} color="#f472b6" shadow={false} />
        </group>

        {/* Tail, curving up from the back, swishing. */}
        <group ref={tail} position={[0, 0.33, 0.27]}>
          <group rotation={[-0.7, 0, 0]}>
            <Block position={[0, 0, 0.18]} size={[0.06, 0.06, 0.38]} color={fur} />
            <Block position={[0, 0, 0.34]} size={[0.065, 0.065, 0.06]} color={stripe} shadow={false} />
          </group>
        </group>
      </group>
    </group>
  );
}
