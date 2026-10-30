"use client";

import { Html } from "@react-three/drei";

import type { Seat } from "./office-amenities";
import { Block, Round } from "./office-block";
import { CutawayWall } from "./office-decor";
import { Extinguisher, GlassDoors, GlassPane } from "./office-doors";
import { Picture, useImage, useTextTexture } from "./office-props";

/**
 * The slide on the all-hands screen. Drop the team's slide here — 16:9 — and
 * it replaces the title card, no code change.
 */
const SLIDE = "/assets/allhands-slide.png";

/** Window positions along a side wall of length `d`, kept clear of the corners. */
function windowsAlong(d: number): number[] {
  const count = Math.max(1, Math.floor((d - 1.5) / 2.6));
  const step = (d - 1.5) / count;
  return Array.from({ length: count }, (_, i) => 0.75 + step * (i + 0.5));
}

/**
 * The all-hands room — where every department meets on Fridays, 4 to 5 PM.
 *
 * A stage at the back with a podium and a big screen, rows of chairs facing it,
 * sized to seat everyone in scope. Its geometry (`townHallSize`, `townHallSeats`,
 * `podium`) is shared with the scene, so the people at the meeting sit in the
 * chairs that are drawn.
 *
 * Coordinates are the building's: the room spans `x … x + w`, `z … z + d`.
 */

const BRAND = "#4359a5";
const SEAT_GAP = 0.9;
const ROW_GAP = 1.05;
/** Stage and aisle in front of it, before the first row. */
const FRONT = 3.4;
const BACK = 1.4;
/** Ten across, three deep: 30 chairs for a team of about 20, with room to grow. */
const COLS = 10;
const MIN_SEATS = 30;

/**
 * How deep the room must be for its chairs: 30, ten to a row — more rows only
 * if more than 30 people are ever in scope. `w` caps the row if the room is narrow.
 */
export function townHallSize(count: number, w: number): { cols: number; rows: number; d: number } {
  const cols = Math.max(4, Math.min(COLS, Math.floor((w - 3) / SEAT_GAP)));
  const rows = Math.ceil(Math.max(MIN_SEATS, count) / cols);
  return { cols, rows, d: FRONT + rows * ROW_GAP + BACK };
}

/** Every chair, facing the stage (−Z). A centre aisle splits each row. */
export function townHallSeats(x: number, z: number, w: number, count: number): Seat[] {
  const { cols, rows } = townHallSize(count, w);
  const span = (cols - 1) * SEAT_GAP + 0.8;
  const left = x + (w - span) / 2;
  const seats: Seat[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const aisle = col >= cols / 2 ? 0.8 : 0;
      seats.push({ x: left + col * SEAT_GAP + aisle, z: z + FRONT + row * ROW_GAP, facing: 0 });
    }
  }
  return seats;
}

/** Where the presenter stands: behind the podium, facing the room (+Z). */
export function podium(x: number, z: number, w: number): Seat {
  return { x: x + w / 2 + 1.6, z: z + 1.55, facing: Math.PI };
}

function Chair({ seat }: { seat: Seat }) {
  return (
    <group position={[seat.x, 0, seat.z]} rotation={[0, seat.facing, 0]}>
      <Block position={[0, 0.45, 0]} size={[0.5, 0.07, 0.48]} color={BRAND} />
      <Block position={[0, 0.76, 0.22]} size={[0.5, 0.56, 0.06]} color={BRAND} />
      <Block position={[-0.2, 0.22, 0]} size={[0.04, 0.44, 0.4]} color="#1f2937" />
      <Block position={[0.2, 0.22, 0]} size={[0.04, 0.44, 0.4]} color="#1f2937" />
    </group>
  );
}

export function TownHall({ x, z, w, count, live }: { x: number; z: number; w: number; count: number; live: boolean }) {
  const { d } = townHallSize(count, w);
  const seats = townHallSeats(x, z, w, count);
  const title = useTextTexture("FRIDAY ALL-HANDS · 4:00 PM", "#ffffff", 120, 1800, 220);
  // The team's own slide when it is there; the title card until then.
  const slide = useImage(SLIDE);
  const T = 0.18;
  const H = 2.4;
  const door = 2.4;
  const half = (w - door) / 2;
  const wall = { height: H, low: 0.55, accent: BRAND };

  return (
    <group>
      {/* Carpet. */}
      <Block position={[x + w / 2, 0.03, z + d / 2]} size={[w - 0.5, 0.04, d - 0.5]} color="#dbe3f7" shadow={false} />

      {/* Walls, with double doors in the front. */}
      <CutawayWall center={[x + w / 2, 0, z + T / 2]} size={[w, T]} normal={[0, -1]} {...wall}>
        {/* The big screen over the stage, 16:9. */}
        <group position={[x + w / 2, 1.4, z + T + 0.03]}>
          <Block position={[0, 0, 0]} size={[3.5, 2, 0.06]} color="#111827" />
          <Block position={[0, 0, 0.035]} size={[3.3, 1.86, 0.01]} color="#0f172a" emissive={live ? "#1e3a8a" : "#000000"} emissiveIntensity={live ? 0.4 : 0} />
          <group position={[0, 0, 0.045]}>
            {slide ? <Picture texture={slide} w={3.3} h={1.86} /> : <Picture texture={title} w={3} h={0.4} />}
          </group>
        </group>
      </CutawayWall>
      {/* Side walls, each with windows. */}
      <CutawayWall center={[x + T / 2, 0, z + d / 2]} size={[T, d]} normal={[-1, 0]} {...wall}>
        {windowsAlong(d).map((wz) => (
          <GlassPane key={wz} x={x + T / 2} y={1.4} z={z + wz} along="z" />
        ))}
      </CutawayWall>
      <CutawayWall center={[x + w - T / 2, 0, z + d / 2]} size={[T, d]} normal={[1, 0]} {...wall}>
        {windowsAlong(d).map((wz) => (
          <GlassPane key={wz} x={x + w - T / 2} y={1.4} z={z + wz} along="z" />
        ))}
      </CutawayWall>
      <CutawayWall center={[x + half / 2, 0, z + d - T / 2]} size={[half, T]} normal={[0, 1]} {...wall} />
      <CutawayWall center={[x + w - half / 2, 0, z + d - T / 2]} size={[half, T]} normal={[0, 1]} {...wall} />
      {/* The way in: glass double doors with the room's name over them. */}
      <GlassDoors x={x + w / 2} z={z + d - T / 2} width={door} label="ALL-HANDS" />
      <Extinguisher x={x + w / 2 - door / 2 - 0.5} z={z + d - 0.6} />

      {/* The stage, a podium, and speakers either side. */}
      <Block position={[x + w / 2, 0.12, z + 1.3]} size={[Math.min(w - 2, 8), 0.24, 1.9]} color="#78350f" />
      <Block position={[x + w / 2, 0.245, z + 2.24]} size={[Math.min(w - 2, 8), 0.02, 0.04]} color="#facc15" shadow={false} />
      <group position={[x + w / 2 + 1.6, 0.24, z + 1.1]}>
        <Block position={[0, 0.5, 0]} size={[0.6, 1, 0.45]} color="#1f2937" />
        <Block position={[0, 1.02, 0.05]} size={[0.66, 0.05, 0.5]} color="#374151" rotation={[0.25, 0, 0]} />
        <Block position={[0, 0.6, 0.23]} size={[0.3, 0.3, 0.01]} color={BRAND} shadow={false} />
      </group>
      {[-1, 1].map((side) => (
        <group key={side} position={[x + w / 2 + side * (Math.min(w - 2, 8) / 2 - 0.3), 0.24, z + 0.7]}>
          <Block position={[0, 0.55, 0]} size={[0.45, 1.1, 0.4]} color="#111827" />
          <Round position={[0, 0.75, 0.21]} radius={0.13} height={0.02} color="#374151" segments={12} />
          <Round position={[0, 0.35, 0.21]} radius={0.08} height={0.02} color="#374151" segments={12} />
        </group>
      ))}

      {seats.map((seat, i) => (
        <Chair key={i} seat={seat} />
      ))}

      {/* Plants in the back corners. */}
      {[x + 0.7, x + w - 0.7].map((px) => (
        <group key={px} position={[px, 0, z + d - 0.8]}>
          <Round position={[0, 0.22, 0]} radius={0.24} height={0.44} color="#d6d3d1" segments={12} />
          <Block position={[0, 0.68, 0]} size={[0.55, 0.5, 0.55]} color="#3f9b54" />
        </group>
      ))}

      <Html position={[x + 0.8, 2.6, z + 0.8]} zIndexRange={[15, 5]} style={{ pointerEvents: "none" }}>
        <div className="whitespace-nowrap rounded border border-black/20 px-2 py-1 leading-none text-white shadow-md" style={{ background: BRAND }}>
          <p className="text-[11px] font-bold tracking-wider">ALL-HANDS ROOM</p>
          <p className="mt-0.5 text-[9px] opacity-85">{live ? "IN SESSION · UNTIL 5 PM" : "FRIDAYS · 4–5 PM"}</p>
        </div>
      </Html>
    </group>
  );
}
