"use client";

import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3, type Group, type Mesh, type MeshStandardMaterial } from "three";

import type { OfficeTheme as Theme } from "@/lib/office";

import { Block } from "./office-block";
import { Extinguisher, GlassPane, RoomDoor } from "./office-doors";
import { Plaque } from "./office-props";

/**
 * Each department's room in the virtual office: its walls, and a back wall
 * dressed for what the department does.
 *
 * - media / marketing — an animated ad screen, a jumping equalizer, ON AIR.
 * - bytes / dev       — a code screen that keeps typing, a `</>` sign, two
 *                       meshing gears for automation.
 * - books / accounting — a growth chart that keeps climbing, a ₱ coin, a clock,
 *                       filing cabinets.
 * - assists (VA)      — deliberately plain: a calendar, a to-do board, a clock.
 * - anything else     — a framed poster in the room's colour and a clock.
 *
 * The theme is guessed from the department's NAME by `officeTheme` in
 * `lib/office.ts`, so a new department gets the plain poster until a word is
 * added there. Animation steps rather than
 * tweens, like everything else in the office — pixel art moves in whole steps.
 *
 * Coordinates: the room's back-left corner is (0, 0, 0); X runs along the back
 * wall, Z into the room. Decor hangs on the back wall's inner face.
 */

const WALL = "#ece6dc";
/** Back and left walls, full height; front and right, cut low so the camera sees in. */
export const ROOM_WALL_H = 1.7;
const LOW = 0.55;
const TH = 0.18;
const DOOR = 1.8;
/** The inner face of the back wall, where the decor hangs. */
const FACE = TH + 0.02;

/** Steps a value every `period` seconds — the pixel-art clock everything here runs on. */
function useStep(period: number, onStep: (step: number) => void) {
  const last = useRef(-1);
  useFrame(({ clock }) => {
    const step = Math.floor(clock.elapsedTime / period);
    if (step !== last.current) {
      last.current = step;
      onStep(step);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Walls                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A wall that drops to `low` whenever the camera is on its outside — the Sims'
 * "walls cutaway". Four full walls with decor on every one, and the camera can
 * still always see in: the walls nearest it go down, the far ones stay up, and
 * rotating round the room swaps them.
 *
 * `normal` is the wall's OUTWARD direction on the floor plane. The decor is
 * hidden while the wall is down — a poster floating at head height over a
 * knee-high wall reads as a glitch.
 *
 * Only re-renders nothing: the check runs per frame and touches the meshes
 * directly, and only when the answer changes.
 */
export function CutawayWall({
  center,
  size,
  normal,
  height,
  low,
  color = WALL,
  accent,
  children,
}: {
  center: [number, number, number];
  /** Footprint on the floor: [along X, along Z]. */
  size: [number, number];
  normal: [number, number];
  height: number;
  low: number;
  color?: string;
  accent?: string;
  children?: React.ReactNode;
}) {
  const anchor = useRef<Group>(null);
  const wall = useRef<Mesh>(null);
  const stripe = useRef<Mesh>(null);
  const decor = useRef<Group>(null);
  const cut = useRef<boolean | null>(null);
  const camera = useThree((state) => state.camera);
  const world = useMemo(() => new Vector3(), []);

  useFrame(() => {
    if (!anchor.current || !wall.current) return;
    anchor.current.getWorldPosition(world);
    const outside = (camera.position.x - world.x) * normal[0] + (camera.position.z - world.z) * normal[1] > 0;
    if (outside === cut.current) return;
    cut.current = outside;
    const h = outside ? low : height;
    wall.current.scale.y = h / height;
    wall.current.position.y = h / 2;
    if (stripe.current) stripe.current.position.y = h + 0.03;
    if (decor.current) decor.current.visible = !outside;
  });

  return (
    <group>
      <group ref={anchor} position={center} />
      {/* Skirting board: a darker strip along the foot, both faces. */}
      <mesh position={[center[0], 0.06, center[2]]}>
        <boxGeometry args={[size[0] + 0.02, 0.12, size[1] + 0.02]} />
        <meshStandardMaterial color="#a8a29e" flatShading />
      </mesh>
      <mesh ref={wall} position={[center[0], height / 2, center[2]]} castShadow receiveShadow>
        <boxGeometry args={[size[0], height, size[1]]} />
        <meshStandardMaterial color={color} flatShading roughness={0.9} />
      </mesh>
      {accent ? (
        <mesh ref={stripe} position={[center[0], height + 0.03, center[2]]}>
          <boxGeometry args={[size[0] + 0.02, 0.06, size[1] + 0.02]} />
          <meshStandardMaterial color={accent} flatShading />
        </mesh>
      ) : null}
      <group ref={decor}>{children}</group>
    </group>
  );
}

/**
 * How far into a room of depth `d` its meeting corner sits — the table, the
 * projector and the screen on the right wall all line up on it.
 */
export function meetingDepth(d: number): number {
  return Math.max(2.8, d / 2 + 0.3);
}

/**
 * The room's four walls, each dressed. Decor for a side wall is drawn as if on
 * the back wall and turned into place: X runs along the wall, Z out of it.
 */
export function RoomWalls({ w, d, accent, theme }: { w: number; d: number; accent: string; theme: Theme }) {
  const half = (w - DOOR) / 2;
  const wall = { height: ROOM_WALL_H, low: LOW, accent };
  return (
    <group>
      {/* Back: the department's main wall. */}
      <CutawayWall center={[w / 2, 0, TH / 2]} size={[w, TH]} normal={[0, -1]} {...wall}>
        <WallDecor theme={theme} accent={accent} />
      </CutawayWall>

      {/* Left. */}
      <CutawayWall center={[TH / 2, 0, d / 2]} size={[TH, d]} normal={[-1, 0]} {...wall}>
        <group position={[0, 0, d]} rotation={[0, Math.PI / 2, 0]}>
          <SideDecor theme={theme} accent={accent} length={d} />
        </group>
      </CutawayWall>

      {/* Right. */}
      <CutawayWall center={[w - TH / 2, 0, d / 2]} size={[TH, d]} normal={[1, 0]} {...wall}>
        <group position={[w, 0, 0]} rotation={[0, -Math.PI / 2, 0]}>
          <RightDecor length={d} screenAt={meetingDepth(d)} accent={accent} />
        </group>
      </CutawayWall>

      {/* Front, either side of the doorway — each with a window onto the hall. */}
      <CutawayWall center={[half / 2, 0, d - TH / 2]} size={[half, TH]} normal={[0, 1]} {...wall}>
        <group position={[w, 0, d]} rotation={[0, Math.PI, 0]}>
          <Poster x={w - half / 2} accent={accent} />
        </group>
        <GlassPane x={Math.max(1.1, half / 2 - 1.6)} y={1.05} z={d - TH / 2} along="x" />
      </CutawayWall>
      <CutawayWall center={[w - half / 2, 0, d - TH / 2]} size={[half, TH]} normal={[0, 1]} {...wall}>
        <group position={[w, 0, d]} rotation={[0, Math.PI, 0]}>
          <Clock x={half / 2} y={1.25} />
        </group>
        <GlassPane x={Math.min(w - 1.1, w - half / 2 + 1.6)} y={1.05} z={d - TH / 2} along="x" />
      </CutawayWall>

      {/* The door itself stands outside the cut-away walls, so it never vanishes. */}
      <RoomDoor x={half} width={DOOR} z={d - TH / 2} />
      <Extinguisher x={half - 0.45} z={d - 0.55} />
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                                */
/* -------------------------------------------------------------------------- */

/** A round wall clock whose hands actually tell the time. */
function Clock({ x, y }: { x: number; y: number }) {
  const minute = useRef<Mesh>(null);
  const hour = useRef<Mesh>(null);
  useStep(1, () => {
    const now = new Date();
    const m = now.getMinutes();
    const h = (now.getHours() % 12) + m / 60;
    if (minute.current) minute.current.rotation.z = -(m / 60) * Math.PI * 2;
    if (hour.current) hour.current.rotation.z = -(h / 12) * Math.PI * 2;
  });
  return (
    <group position={[x, y, FACE]}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.3, 0.3, 0.05, 12]} />
        <meshStandardMaterial color="#ffffff" flatShading />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.005]}>
        <cylinderGeometry args={[0.34, 0.34, 0.04, 12]} />
        <meshStandardMaterial color="#374151" flatShading />
      </mesh>
      <mesh ref={hour} position={[0, 0, 0.035]}>
        <boxGeometry args={[0.04, 0.32, 0.01]} />
        <meshStandardMaterial color="#111827" />
      </mesh>
      <mesh ref={minute} position={[0, 0, 0.04]}>
        <boxGeometry args={[0.03, 0.46, 0.01]} />
        <meshStandardMaterial color="#111827" />
      </mesh>
    </group>
  );
}

/** A frame on the wall. Children are positioned on its face. */
function Board({
  x,
  y,
  w,
  h,
  color = "#ffffff",
  frame = "#4b5563",
  children,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
  frame?: string;
  children?: React.ReactNode;
}) {
  return (
    <group position={[x, y, FACE]}>
      <Block position={[0, 0, 0]} size={[w + 0.1, h + 0.1, 0.03]} color={frame} />
      <Block position={[0, 0, 0.02]} size={[w, h, 0.02]} color={color} />
      <group position={[0, 0, 0.035]}>{children}</group>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Media / marketing                                                            */
/* -------------------------------------------------------------------------- */

const AD_COLORS = ["#ec4899", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7"];

function MediaWall() {
  const screen = useRef<MeshStandardMaterial>(null);
  const bars = useRef<Group>(null);
  const onAir = useRef<MeshStandardMaterial>(null);

  useStep(0.7, (step) => {
    const c = AD_COLORS[step % AD_COLORS.length];
    screen.current?.color.set(c);
    screen.current?.emissive.set(c);
  });
  useStep(0.18, (step) => {
    bars.current?.children.forEach((bar, i) => {
      bar.scale.y = 0.3 + (((step * 7 + i * 3) % 5) / 4) * 0.7;
    });
  });
  useStep(0.6, (step) => onAir.current?.emissive.set(step % 2 ? "#ef4444" : "#3f1010"));

  return (
    <group>
      {/* The ad screen with a play button. */}
      <group position={[2.2, 1.05, FACE]}>
        <Block position={[0, 0, 0]} size={[2.5, 1.3, 0.06]} color="#111827" />
        <mesh position={[0, 0, 0.04]}>
          <boxGeometry args={[2.3, 1.1, 0.02]} />
          <meshStandardMaterial ref={screen} color={AD_COLORS[0]} emissive={AD_COLORS[0]} emissiveIntensity={0.55} flatShading />
        </mesh>
        <mesh position={[0.05, 0, 0.07]} rotation={[Math.PI / 2, 0, -Math.PI / 2]}>
          <cylinderGeometry args={[0.24, 0.24, 0.02, 3]} />
          <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.4} />
        </mesh>
      </group>
      {/* An equalizer that jumps. */}
      <group ref={bars} position={[4.1, 0.55, FACE + 0.02]}>
        {[0, 1, 2, 3, 4].map((i) => (
          <mesh key={i} position={[i * 0.17, 0.4, 0]} scale={[1, 0.6, 1]}>
            <boxGeometry args={[0.12, 0.8, 0.03]} />
            <meshStandardMaterial color={AD_COLORS[i]} emissive={AD_COLORS[i]} emissiveIntensity={0.35} flatShading />
          </mesh>
        ))}
      </group>
      {/* ON AIR. */}
      <group position={[4.45, 1.5, FACE]}>
        <Block position={[0, 0, 0]} size={[0.9, 0.3, 0.05]} color="#1f2937" />
        <mesh position={[0, 0, 0.035]}>
          <boxGeometry args={[0.8, 0.2, 0.02]} />
          <meshStandardMaterial ref={onAir} color="#ef4444" emissive="#ef4444" emissiveIntensity={0.8} />
        </mesh>
      </group>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Bytes / dev                                                                  */
/* -------------------------------------------------------------------------- */

const CODE = ["#c084fc", "#60a5fa", "#4ade80", "#f472b6", "#facc15", "#94a3b8"];

function Gear({ x, y, r, speed, color }: { x: number; y: number; r: number; speed: number; color: string }) {
  const gear = useRef<Group>(null);
  useStep(0.12, (step) => {
    if (gear.current) gear.current.rotation.z = step * speed * (Math.PI / 8);
  });
  return (
    <group ref={gear} position={[x, y, 0]}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[r, r, 0.04, 8]} />
        <meshStandardMaterial color={color} flatShading />
      </mesh>
      {Array.from({ length: 8 }, (_, i) => (
        <mesh key={i} rotation={[0, 0, (i * Math.PI) / 4]}>
          <boxGeometry args={[r * 0.35, r * 2.5, 0.04]} />
          <meshStandardMaterial color={color} flatShading />
        </mesh>
      ))}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.01]}>
        <cylinderGeometry args={[r * 0.35, r * 0.35, 0.05, 8]} />
        <meshStandardMaterial color="#1f2937" />
      </mesh>
    </group>
  );
}

function BytesWall() {
  const lines = useRef<Group>(null);
  useStep(0.35, (step) => {
    lines.current?.children.forEach((line, i) => {
      // Each line "types" across, then the next one starts.
      const typing = step % 8;
      line.scale.x = i < typing ? 1 : i === typing ? 0.5 : 0.001;
      line.position.x = -0.95 + (line.scale.x * widthOf(i)) / 2 + indentOf(i);
    });
  });

  return (
    <group>
      {/* The code screen. */}
      <group position={[2, 1.05, FACE]}>
        <Block position={[0, 0, 0]} size={[2.3, 1.3, 0.06]} color="#111827" />
        <Block position={[0, 0, 0.035]} size={[2.15, 1.15, 0.02]} color="#0b1220" emissive="#0b1220" emissiveIntensity={0.3} />
        <group ref={lines} position={[0, 0, 0.055]}>
          {Array.from({ length: 7 }, (_, i) => (
            <mesh key={i} position={[-0.95 + widthOf(i) / 2 + indentOf(i), 0.42 - i * 0.14, 0]}>
              <boxGeometry args={[widthOf(i), 0.07, 0.01]} />
              <meshStandardMaterial color={CODE[i % CODE.length]} emissive={CODE[i % CODE.length]} emissiveIntensity={0.6} />
            </mesh>
          ))}
        </group>
      </group>

      {/* </> — made of bricks. */}
      <group position={[3.85, 1.35, FACE + 0.03]}>
        <Block position={[-0.32, 0.07, 0]} size={[0.06, 0.2, 0.03]} color="#22c55e" />
        <mesh position={[-0.32, 0.07, 0]} rotation={[0, 0, -0.9]}>
          <boxGeometry args={[0.06, 0.22, 0.03]} />
          <meshStandardMaterial color="#22c55e" />
        </mesh>
        <mesh position={[-0.32, -0.07, 0]} rotation={[0, 0, 0.9]}>
          <boxGeometry args={[0.06, 0.22, 0.03]} />
          <meshStandardMaterial color="#22c55e" />
        </mesh>
        <mesh position={[0, 0, 0]} rotation={[0, 0, -0.45]}>
          <boxGeometry args={[0.06, 0.42, 0.03]} />
          <meshStandardMaterial color="#22c55e" />
        </mesh>
        <mesh position={[0.32, 0.07, 0]} rotation={[0, 0, 0.9]}>
          <boxGeometry args={[0.06, 0.22, 0.03]} />
          <meshStandardMaterial color="#22c55e" />
        </mesh>
        <mesh position={[0.32, -0.07, 0]} rotation={[0, 0, -0.9]}>
          <boxGeometry args={[0.06, 0.22, 0.03]} />
          <meshStandardMaterial color="#22c55e" />
        </mesh>
      </group>

      {/* AUTOMATE: two meshing gears. */}
      <Board x={4.1} y={0.75} w={1.1} h={0.75} color="#1e293b" frame="#0f172a">
        <Gear x={-0.2} y={0} r={0.17} speed={1} color="#f59e0b" />
        <Gear x={0.2} y={0.03} r={0.13} speed={-1.3} color="#94a3b8" />
      </Board>
    </group>
  );
}

const widthOf = (i: number) => [1.2, 0.8, 1.5, 0.6, 1.1, 0.9, 0.5][i % 7];
const indentOf = (i: number) => [0, 0.2, 0.2, 0.4, 0.2, 0, 0][i % 7];

/* -------------------------------------------------------------------------- */
/* Books / accounting                                                           */
/* -------------------------------------------------------------------------- */

function BooksWall() {
  const bars = useRef<Group>(null);
  useStep(0.5, (step) => {
    const grown = (step % 7) + 1; // the chart re-draws, bar by bar
    bars.current?.children.forEach((bar, i) => {
      bar.visible = i < grown;
    });
  });

  return (
    <group>
      {/* The growth chart. */}
      <Board x={1.9} y={1.05} w={2.2} h={1.2}>
        <Block position={[-0.95, -0.05, 0]} size={[0.03, 1, 0.01]} color="#374151" />
        <Block position={[0, -0.53, 0]} size={[1.95, 0.03, 0.01]} color="#374151" />
        <group ref={bars}>
          {[0.25, 0.35, 0.3, 0.5, 0.6, 0.7, 0.9].map((h, i) => (
            <mesh key={i} position={[-0.75 + i * 0.26, -0.52 + h / 2, 0]}>
              <boxGeometry args={[0.16, h, 0.01]} />
              <meshStandardMaterial color={i === 6 ? "#16a34a" : "#4ade80"} />
            </mesh>
          ))}
        </group>
      </Board>

      {/* The ₱ coin. */}
      <group position={[3.7, 1.25, FACE + 0.02]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.32, 0.32, 0.05, 12]} />
          <meshStandardMaterial color="#eab308" emissive="#eab308" emissiveIntensity={0.2} flatShading />
        </mesh>
        <Block position={[-0.04, 0, 0.035]} size={[0.06, 0.36, 0.01]} color="#854d0e" />
        <Block position={[0.06, 0.1, 0.035]} size={[0.16, 0.05, 0.01]} color="#854d0e" />
        <Block position={[0.06, 0.02, 0.035]} size={[0.16, 0.05, 0.01]} color="#854d0e" />
        <Block position={[0.13, 0.06, 0.035]} size={[0.05, 0.12, 0.01]} color="#854d0e" />
      </group>

      <Clock x={4.6} y={1.3} />

      {/* Filing cabinets against the wall. */}
      {[3.55, 4.15].map((cx) => (
        <group key={cx} position={[cx, 0, FACE + 0.3]}>
          <Block position={[0, 0.5, 0]} size={[0.55, 1, 0.55]} color="#9ca3af" />
          {[0.25, 0.55, 0.85].map((y) => (
            <Block key={y} position={[0, y, 0.28]} size={[0.2, 0.04, 0.02]} color="#4b5563" />
          ))}
        </group>
      ))}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Assists — plain                                                              */
/* -------------------------------------------------------------------------- */

function AssistWall({ accent }: { accent: string }) {
  const today = new Date().getDate();
  return (
    <group>
      {/* A month on the wall, today marked. */}
      <Board x={1.7} y={1.05} w={1.5} h={1.15}>
        <Block position={[0, 0.48, 0]} size={[1.5, 0.2, 0.01]} color="#ef4444" />
        {Array.from({ length: 28 }, (_, i) => (
          <Block
            key={i}
            position={[-0.6 + (i % 7) * 0.2, 0.25 - Math.floor(i / 7) * 0.2, 0]}
            size={[0.14, 0.14, 0.01]}
            color={i + 1 === Math.min(today, 28) ? accent : "#e5e7eb"}
          />
        ))}
      </Board>

      {/* A to-do board, ticked off. */}
      <Board x={3.4} y={1.05} w={1.4} h={1}>
        {[0, 1, 2, 3].map((i) => (
          <group key={i} position={[0, 0.3 - i * 0.2, 0]}>
            <Block position={[-0.5, 0, 0]} size={[0.12, 0.12, 0.01]} color={i < 3 ? "#22c55e" : "#d1d5db"} />
            <Block position={[0.08, 0, 0]} size={[0.9 - (i % 2) * 0.25, 0.05, 0.01]} color="#6b7280" />
          </group>
        ))}
      </Board>

      <Clock x={4.7} y={1.3} />
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Anything else                                                                */
/* -------------------------------------------------------------------------- */

function PlainWall({ accent }: { accent: string }) {
  return (
    <group>
      <Board x={2} y={1.05} w={1.6} h={1} color={accent} frame="#1f2937">
        <Block position={[0, 0.15, 0]} size={[0.9, 0.12, 0.01]} color="#ffffff" />
        <Block position={[0, -0.1, 0]} size={[0.6, 0.08, 0.01]} color="#ffffff" />
      </Board>
      <Clock x={3.6} y={1.3} />
    </group>
  );
}

export function WallDecor({ theme, accent }: { theme: Theme; accent: string }) {
  switch (theme) {
    case "media":
      return <MediaWall />;
    case "bytes":
      return <BytesWall />;
    case "books":
      return <BooksWall />;
    case "assist":
      return <AssistWall accent={accent} />;
    case "plain":
      return <PlainWall accent={accent} />;
  }
}

/* -------------------------------------------------------------------------- */
/* The other three walls                                                        */
/* -------------------------------------------------------------------------- */

/** A small framed poster in the room's colour. */
function Poster({ x, accent }: { x: number; accent: string }) {
  return (
    <Board x={x} y={1.05} w={0.8} h={1} color={accent} frame="#1f2937">
      <Block position={[0, 0.2, 0]} size={[0.5, 0.08, 0.01]} color="#ffffff" />
      <Block position={[0, 0.02, 0]} size={[0.36, 0.06, 0.01]} color="#ffffff" />
      <Block position={[0, -0.25, 0]} size={[0.3, 0.3, 0.01]} color="#ffffff" />
    </Board>
  );
}

/** A corkboard with sticky notes. */
function Corkboard({ x }: { x: number }) {
  const notes = ["#fde047", "#f9a8d4", "#93c5fd", "#86efac", "#fde047", "#fdba74"];
  return (
    <Board x={x} y={1.1} w={1.4} h={0.9} color="#b08355" frame="#6b4f34">
      {notes.map((c, i) => (
        <Block key={i} position={[-0.45 + (i % 3) * 0.45, 0.18 - Math.floor(i / 3) * 0.38, 0]} size={[0.28, 0.28, 0.01]} color={c} />
      ))}
    </Board>
  );
}

/** A server rack with blinking lights. */
function ServerRack({ x }: { x: number }) {
  const lights = useRef<Group>(null);
  useStep(0.25, (step) => {
    lights.current?.children.forEach((light, i) => {
      light.visible = ((step + i * 3) % 5) !== 0;
    });
  });
  return (
    <group position={[x, 0, FACE + 0.35]}>
      <Block position={[0, 0.8, 0]} size={[0.7, 1.6, 0.6]} color="#1f2937" />
      <group ref={lights}>
        {Array.from({ length: 12 }, (_, i) => (
          <mesh key={i} position={[-0.2 + (i % 3) * 0.2, 0.3 + Math.floor(i / 3) * 0.32, 0.31]}>
            <boxGeometry args={[0.07, 0.05, 0.01]} />
            <meshStandardMaterial
              color={i % 4 === 0 ? "#f59e0b" : "#22c55e"}
              emissive={i % 4 === 0 ? "#f59e0b" : "#22c55e"}
              emissiveIntensity={0.9}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** The department's second wall, on the left. */
function SideDecor({ theme, accent, length }: { theme: Theme; accent: string; length: number }) {
  const mid = length / 2;
  switch (theme) {
    case "media":
      return (
        <group>
          <Board x={mid - 0.75} y={1.05} w={0.9} h={1.15} color="#fdf2f8" frame="#1f2937">
            <Block position={[0, 0.2, 0]} size={[0.5, 0.5, 0.01]} color="#ec4899" />
            <Block position={[0, -0.32, 0]} size={[0.6, 0.08, 0.01]} color="#1f2937" />
          </Board>
          <Board x={mid + 0.75} y={1.05} w={0.9} h={1.15} color="#fffbeb" frame="#1f2937">
            <Block position={[-0.12, 0.15, 0]} size={[0.3, 0.3, 0.01]} color="#f59e0b" />
            <Block position={[0.15, 0.25, 0]} size={[0.2, 0.2, 0.01]} color="#3b82f6" />
            <Block position={[0, -0.3, 0]} size={[0.6, 0.08, 0.01]} color="#1f2937" />
          </Board>
        </group>
      );
    case "bytes":
      return (
        <group>
          <Board x={mid - 0.6} y={1.1} w={1.3} h={0.85} color="#0b1220" frame="#111827">
            {[0, 1, 2, 3].map((i) => (
              <Block key={i} position={[-0.25 + (i % 2) * 0.15, 0.25 - i * 0.16, 0]} size={[0.6 - i * 0.08, 0.06, 0.01]} color="#4ade80" />
            ))}
          </Board>
          <ServerRack x={mid + 1} />
        </group>
      );
    case "books":
      return (
        <group>
          {/* A calculator poster. */}
          <Board x={mid - 0.6} y={1.1} w={0.8} h={1.1} color="#e5e7eb" frame="#374151">
            <Block position={[0, 0.35, 0]} size={[0.6, 0.2, 0.01]} color="#a3e635" />
            {Array.from({ length: 12 }, (_, i) => (
              <Block key={i} position={[-0.2 + (i % 3) * 0.2, 0.1 - Math.floor(i / 3) * 0.16, 0]} size={[0.14, 0.11, 0.01]} color={i % 3 === 2 ? "#f59e0b" : "#6b7280"} />
            ))}
          </Board>
          {/* Binders on a low cabinet. */}
          <group position={[mid + 0.8, 0, FACE + 0.3]}>
            <Block position={[0, 0.4, 0]} size={[1.4, 0.8, 0.55]} color="#9ca3af" />
            {["#1d4ed8", "#dc2626", "#16a34a", "#ca8a04", "#7c3aed"].map((c, i) => (
              <Block key={c} position={[-0.5 + i * 0.25, 1, 0]} size={[0.18, 0.4, 0.45]} color={c} />
            ))}
          </group>
        </group>
      );
    case "assist":
      return <Corkboard x={mid} />;
    case "plain":
      return (
        <group>
          <Corkboard x={mid - 0.9} />
          <Poster x={mid + 0.9} accent={accent} />
        </group>
      );
  }
}

/**
 * The projector screen, in the meeting corner: four slides on a loop — a title
 * in VizServe blue, a bar chart, a line chart, a pie.
 */
function ProjectorScreen({ x, accent }: { x: number; accent: string }) {
  const slides = useRef<Group>(null);
  useStep(4, (step) => {
    slides.current?.children.forEach((slide, i) => {
      slide.visible = i === step % 4;
    });
  });
  const W = 2.2;
  const H = 1.3;
  return (
    <group position={[x, 1.3, FACE]}>
      {/* The roller case, and the screen hanging from it. */}
      <Block position={[0, H / 2 + 0.08, 0.04]} size={[W + 0.2, 0.1, 0.12]} color="#374151" />
      <Block position={[0, 0, 0.01]} size={[W, H, 0.01]} color="#f8fafc" emissive="#f8fafc" emissiveIntensity={0.25} />
      <group ref={slides} position={[0, 0, 0.025]}>
        {/* Title. */}
        <group>
          <Block position={[0, 0, 0]} size={[W - 0.2, H - 0.2, 0.005]} color="#4359a5" emissive="#4359a5" emissiveIntensity={0.3} />
          <Block position={[0, 0.12, 0.005]} size={[1.2, 0.12, 0.005]} color="#ffffff" />
          <Block position={[0, -0.1, 0.005]} size={[0.8, 0.07, 0.005]} color="#bfdbfe" />
        </group>
        {/* Bars. */}
        <group visible={false}>
          {[0.3, 0.5, 0.4, 0.7, 0.85].map((h, i) => (
            <Block key={i} position={[-0.7 + i * 0.35, -0.45 + h / 2, 0]} size={[0.22, h, 0.005]} color={i === 4 ? accent : "#93c5fd"} />
          ))}
        </group>
        {/* A rising line, in steps. */}
        <group visible={false}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Block key={i} position={[-0.8 + i * 0.32, -0.35 + i * 0.12 + (i % 2) * 0.06, 0]} size={[0.3, 0.05, 0.005]} rotation={[0, 0, 0.35]} color="#16a34a" />
          ))}
        </group>
        {/* A pie. */}
        <group visible={false}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.42, 0.42, 0.005, 24, 1, false, 0, Math.PI * 1.3]} />
            <meshStandardMaterial color={accent} />
          </mesh>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.42, 0.42, 0.004, 24, 1, false, Math.PI * 1.3, Math.PI * 0.7]} />
            <meshStandardMaterial color="#fbbf24" />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/**
 * The right wall: the projector screen over the meeting corner (`screenAt`,
 * along the wall), and the VizServe mark beside it.
 */
function RightDecor({ length, screenAt, accent }: { length: number; screenAt: number; accent: string }) {
  const plaqueAt = screenAt + 1.8 < length - 0.4 ? screenAt + 1.8 : screenAt - 1.8;
  return (
    <group>
      <ProjectorScreen x={screenAt} accent={accent} />
      <Plaque src="/assets/vizserve-logo-color.png" x={plaqueAt} y={1.15} z={FACE + 0.02} size={0.75} />
    </group>
  );
}
