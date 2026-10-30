"use client";

import { Block, Round } from "./office-block";
import { Picture, useTextTexture } from "./office-props";

/**
 * Doors, windows and the safety kit of the virtual office.
 *
 * ⚠️ DOORS ARE DRAWN OUTSIDE THE CUT-AWAY WALLS, on purpose. The walls nearest
 * the camera drop to knee height, and anything hung on them hides with them —
 * which would make every front door, the entrance and the fire exit vanish from
 * the default view. A door frame standing in a cut wall reads fine; a missing
 * exit does not. Windows, which are part of a wall, do go with it.
 */

const WOOD = "#a16207";
const FRAME = "#78350f";

/**
 * A room's double doors, propped open into the room. The gap runs along X from
 * `x` to `x + width`, in the wall at `z`; the room is on the −Z side.
 */
export function RoomDoor({ x, width, z, height = 1.5 }: { x: number; width: number; z: number; height?: number }) {
  const leaf = width / 2 - 0.04;
  const open = 1.15;
  return (
    <group>
      {/* Frame: two jambs and a header. */}
      <Block position={[x + 0.04, height / 2, z]} size={[0.08, height, 0.24]} color={FRAME} />
      <Block position={[x + width - 0.04, height / 2, z]} size={[0.08, height, 0.24]} color={FRAME} />
      <Block position={[x + width / 2, height + 0.05, z]} size={[width, 0.1, 0.24]} color={FRAME} />
      {/* Two leaves, swung in. */}
      <group position={[x + 0.08, 0, z - 0.06]} rotation={[0, open, 0]}>
        <Block position={[leaf / 2, height / 2 - 0.02, 0]} size={[leaf, height - 0.06, 0.05]} color={WOOD} />
        <Block position={[leaf - 0.1, height / 2, -0.04]} size={[0.04, 0.16, 0.04]} color="#d1d5db" />
      </group>
      <group position={[x + width - 0.08, 0, z - 0.06]} rotation={[0, -open, 0]}>
        <Block position={[-leaf / 2, height / 2 - 0.02, 0]} size={[leaf, height - 0.06, 0.05]} color={WOOD} />
        <Block position={[-leaf + 0.1, height / 2, -0.04]} size={[0.04, 0.16, 0.04]} color="#d1d5db" />
      </group>
    </group>
  );
}

/**
 * Glass double doors in a wall running along X, closed: a metal frame, two
 * panes, long handles. For the all-hands room and the building's entrance.
 * `label` puts a sign over them.
 */
export function GlassDoors({
  x,
  z,
  width,
  height = 2,
  label,
  labelColor = "#4359a5",
  depth = 0.26,
}: {
  x: number;
  z: number;
  width: number;
  height?: number;
  label?: string;
  labelColor?: string;
  /** Front to back. Deeper than the wall it sits in, so it shows through both faces. */
  depth?: number;
}) {
  const sign = useTextTexture(label ?? "", "#ffffff", 120, 1200, 200);
  const pane = width / 2 - 0.08;
  return (
    <group position={[x, 0, z]}>
      <Block position={[-width / 2, height / 2, 0]} size={[0.1, height, depth]} color="#475569" />
      <Block position={[width / 2, height / 2, 0]} size={[0.1, height, depth]} color="#475569" />
      <Block position={[0, height + 0.06, 0]} size={[width + 0.1, 0.12, depth]} color="#475569" />
      <Block position={[0, height / 2, 0]} size={[0.06, height, depth - 0.02]} color="#475569" />
      {[-1, 1].map((side) => (
        <group key={side} position={[side * (pane / 2 + 0.03), height / 2, 0]}>
          <Block position={[0, 0, 0]} size={[pane, height - 0.08, depth - 0.04]} color="#bfe2f1" opacity={0.45} shadow={false} />
          <Block position={[-side * (pane / 2 - 0.12), 0, depth / 2]} size={[0.04, 0.6, 0.04]} color="#d1d5db" />
          <Block position={[-side * (pane / 2 - 0.12), 0, -depth / 2]} size={[0.04, 0.6, 0.04]} color="#d1d5db" />
        </group>
      ))}
      {label ? (
        <group position={[0, height + 0.32, depth / 2 + 0.01]}>
          <Block position={[0, 0, -0.02]} size={[Math.min(width, 2.4), 0.36, 0.04]} color={labelColor} />
          <Picture texture={sign} w={Math.min(width, 2.4) - 0.1} h={0.28} />
        </group>
      ) : null}
    </group>
  );
}

/**
 * The fire exit, in a wall running along Z (the building's right side): a
 * green door with a push bar, the running-man EXIT sign over it lit up, and a
 * red stripe on the floor in front so nobody blocks it. Faces −X.
 */
export function FireExit({ x, z }: { x: number; z: number }) {
  const exit = useTextTexture("EXIT", "#ffffff", 150, 600, 200);
  const label = useTextTexture("FIRE EXIT · KEEP CLEAR", "#ffffff", 90, 1600, 160);
  return (
    <group position={[x, 0, z]} rotation={[0, -Math.PI / 2, 0]}>
      {/* Frame and door. */}
      <Block position={[-0.6, 1.05, 0]} size={[0.1, 2.1, 0.4]} color="#475569" />
      <Block position={[0.6, 1.05, 0]} size={[0.1, 2.1, 0.4]} color="#475569" />
      <Block position={[0, 2.15, 0]} size={[1.3, 0.1, 0.4]} color="#475569" />
      <Block position={[0, 1.04, 0]} size={[1.1, 2.04, 0.36]} color="#166534" />
      {/* Push bar. */}
      <Block position={[0, 1.0, 0.23]} size={[0.9, 0.07, 0.06]} color="#d1d5db" />
      <Block position={[-0.45, 1.0, 0.2]} size={[0.06, 0.12, 0.06]} color="#9ca3af" />
      <Block position={[0.45, 1.0, 0.2]} size={[0.06, 0.12, 0.06]} color="#9ca3af" />
      {/* The door's own label. */}
      <group position={[0, 1.6, 0.185]}>
        <Block position={[0, 0, 0]} size={[0.9, 0.16, 0.01]} color="#b91c1c" shadow={false} />
        <group position={[0, 0, 0.01]}>
          <Picture texture={label} w={0.86} h={0.1} />
        </group>
      </group>
      {/* The lit EXIT sign, with a running figure. */}
      <group position={[0, 2.42, 0.26]}>
        <Block position={[0, 0, 0]} size={[0.8, 0.3, 0.08]} color="#16a34a" emissive="#22c55e" emissiveIntensity={0.9} />
        <group position={[0.12, 0, 0.045]}>
          <Picture texture={exit} w={0.5} h={0.2} />
        </group>
        <group position={[-0.26, 0, 0.045]}>
          <Block position={[0, 0.06, 0]} size={[0.05, 0.05, 0.01]} color="#ffffff" shadow={false} />
          <Block position={[0.01, -0.01, 0]} size={[0.04, 0.1, 0.01]} color="#ffffff" rotation={[0, 0, -0.3]} shadow={false} />
          <Block position={[-0.03, -0.08, 0]} size={[0.03, 0.08, 0.01]} color="#ffffff" rotation={[0, 0, 0.6]} shadow={false} />
          <Block position={[0.04, -0.08, 0]} size={[0.03, 0.08, 0.01]} color="#ffffff" rotation={[0, 0, -0.6]} shadow={false} />
        </group>
      </group>
      {/* Keep-clear stripe on the floor. */}
      <Block position={[0, 0.06, 0.95]} size={[1.4, 0.01, 1.2]} color="#fecaca" shadow={false} />
      <Block position={[0, 0.065, 0.95]} size={[1.4, 0.01, 0.08]} color="#dc2626" shadow={false} />
    </group>
  );
}

/**
 * A fire extinguisher on its floor stand, with a red marker post — floor
 * standing so it is still there when the wall behind it is cut away.
 */
export function Extinguisher({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.03, 0]} size={[0.32, 0.06, 0.32]} color="#1f2937" />
      <Round position={[0, 0.34, 0]} radius={0.1} height={0.56} color="#dc2626" segments={12} />
      <Round position={[0, 0.66, 0]} radius={0.05} height={0.08} color="#111827" segments={8} />
      <Block position={[0.06, 0.7, 0]} size={[0.14, 0.03, 0.04]} color="#111827" />
      <Block position={[-0.07, 0.5, 0.06]} size={[0.03, 0.3, 0.03]} color="#111827" rotation={[0.3, 0, 0]} />
      <Block position={[0, 0.42, 0.1]} size={[0.12, 0.14, 0.01]} color="#ffffff" shadow={false} />
      {/* Marker post. */}
      <Block position={[0.24, 0.55, 0]} size={[0.04, 1.1, 0.04]} color="#9ca3af" />
      <Block position={[0.24, 1.15, 0]} size={[0.22, 0.22, 0.03]} color="#dc2626" />
      <Block position={[0.24, 1.15, 0.02]} size={[0.06, 0.12, 0.01]} color="#ffffff" shadow={false} />
    </group>
  );
}

/**
 * A window through a wall: frame and glass deeper than the wall itself, so it
 * shows on both faces. `along` is the axis the wall runs along.
 */
export function GlassPane({
  x,
  y,
  z,
  along,
  w = 1.6,
  h = 0.75,
}: {
  x: number;
  y: number;
  z: number;
  along: "x" | "z";
  w?: number;
  h?: number;
}) {
  const s = (a: number, b: number, c: number): [number, number, number] => (along === "x" ? [a, b, c] : [c, b, a]);
  return (
    <group position={[x, y, z]}>
      <Block position={[0, 0, 0]} size={s(w + 0.12, h + 0.12, 0.24)} color="#e5e7eb" shadow={false} />
      <Block position={[0, 0, 0]} size={s(w, h, 0.26)} color="#bfe2f1" emissive="#dbeafe" emissiveIntensity={0.3} shadow={false} />
      <Block position={[0, 0, 0]} size={s(0.05, h, 0.27)} color="#e5e7eb" shadow={false} />
    </group>
  );
}
