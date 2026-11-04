"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { Maximize2, Minus, Plus, RotateCcw, RotateCw } from "lucide-react";
import type { Group, Mesh } from "three";
import { MOUSE, TOUCH, Vector3 } from "three";

const UP = new Vector3(0, 1, 0);
/** One press of a turn button or Q / E. */
const TURN = Math.PI / 4;
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AMENITY_W, BATHROOM_SLOT, BATHROOM_STAY, HALL, ROOM_W, assignSeats, bathroomPeriod, describeOfficePerson, isSmoker, wearsPink, type OfficeActivity, officeTheme, type OfficeDesk, type OfficeLayout, type OfficePerson, type OfficeRoom } from "@/lib/office";

import { Block } from "./office-block";
import { MeetingCorner, Printer, WaterDispenser, canteenSeats, type Seat } from "./office-amenities";
import { CutawayWall, RoomWalls, meetingDepth } from "./office-decor";
import { Cat, timeline, type CatStop, type Leg, type Point as FloorPoint } from "./office-cat";
import { ComfortRoom } from "./office-comfort-room";
import { SmokingArea } from "./office-smoking";
import { DESK_ITEMS, DeskItem, Lounge, Window, WoodFloor, canteenSpan, gymZone } from "./office-props";
import { TownHall, podium, townHallSeats, townHallSize } from "./office-townhall";
import { Extinguisher, FireExit, GlassDoors } from "./office-doors";
import { Lobby } from "./office-lobby";
import { NameTag, Sign } from "./office-sign";

/**
 * The virtual office, in 3D — orbit, pan and zoom around one floor of the
 * office, a voxel person at the desk of everyone timed in right now.
 *
 * Voxel-styled — everything is flat-shaded boxes — but rendered at full
 * resolution with antialiasing and soft shadows, so it reads as a detailed
 * miniature rather than pixel art. People's names and the hover card are DOM
 * (`<Html>`), so the text is crisp at any zoom; the room signs are drawn in the
 * scene (`office-sign.tsx`) so none can go missing.
 *
 * The lounge carries the brand: the VizServe and HFSE logos on the reception
 * wall, and every client from vizserve.com on a wall of their own — see
 * `office-props.tsx` and `public/assets/`.
 *
 * The look is a bright, warm office — wood floor, cream walls with windows, a
 * pastel carpet per department — in the scene's own palette, the way a game
 * screen has one, rather than the app's tokens.
 *
 * Loaded with `next/dynamic` and `ssr: false` from `office-view.tsx`: three.js
 * is only downloaded by somebody who opens the office.
 *
 * Grid units from `layoutOffice` are world units: x → X, y → Z, up is Y.
 */

/** The lounge beside the rooms: reception, clients, coffee, games, sofa, meeting table. */
const LOUNGE_W = 8;
/** The all-hands room's width: 30 chairs, ten to a row, and the walls round them. */
const HALL_W = 13.2;
/** A department sign's height, in world units — big enough to read from the overview. */
const SIGN_H = 1;
/** Deep enough for everything the lounge holds, front to back. */
const MIN_DEPTH = 14;
/** Where the fire exit is along the lounge's outer wall: clear of the water and the canteen. */
const FIRE_EXIT_Z = 8.8;
const WALL_H = 2.6;
const CUT_H = 0.5;
/**
 * The floor is three layers — wood, plank lines, carpet — and coplanar layers
 * z-fight: the GPU cannot tell which is on top, and they flicker as the camera
 * moves. So each sits clearly above the last (wood top 0, planks 0.015, rugs
 * 0.05, the hover marker 0.07), and the camera's near plane is not tiny.
 */
const FLOOR_RUG = 0.03;

const BG = "#eef1f6";
const SLAB = "#d6cfc4";
/** One per department: the carpet and the sign. */
const DEPT = [
  { carpet: "#c9d3f2", sign: "#4359a5" },
  { carpet: "#c4e8dc", sign: "#1f8a6b" },
  { carpet: "#f5dcc0", sign: "#c26a12" },
  { carpet: "#e2d2f3", sign: "#7c3fb8" },
  { carpet: "#f6cfdc", sign: "#be3a6a" },
  { carpet: "#cde9f3", sign: "#16799c" },
];
const SHIRTS = ["#e25d5d", "#4f7cff", "#2fb67c", "#f2a33a", "#9b6bff", "#e86fb0", "#22b8cf", "#7a8b99"];
const PANTS = ["#1f2937", "#334155", "#1e3a8a", "#3f3f46", "#44403c"];
const SKIN = ["#f1c7a5", "#e0ac7e", "#c68b5f", "#8d5a3b"];
const HAIR = ["#2b1d14", "#5a3825", "#1b1b1b", "#8b5a2b", "#c79a5b"];

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/* -------------------------------------------------------------------------- */
/* People                                                                       */
/* -------------------------------------------------------------------------- */

function clothesOf(person: OfficePerson): { shirt: string; pants: string } {
  if (wearsPink(person)) return { shirt: "#ec4899", pants: "#f9a8d4" };
  const h = hash(person.id);
  return { shirt: SHIRTS[h % SHIRTS.length], pants: PANTS[(h >>> 3) % PANTS.length] };
}

/**
 * On a head at the origin, facing −Z. `longHair` is the staff record's (P17-14): long
 * past the shoulders, or short with a neat back. Not set keeps the original cut.
 */
function Hair({ person, color }: { person: OfficePerson; color: string }) {
  return (
    <>
      <Block position={[0, 0.21, 0.01]} size={[0.4, 0.1, 0.4]} color={color} />
      {person.longHair === true ? (
        <>
          <Block position={[0, -0.14, 0.2]} size={[0.42, 0.66, 0.08]} color={color} />
          <Block position={[-0.2, -0.06, 0.06]} size={[0.05, 0.5, 0.24]} color={color} />
          <Block position={[0.2, -0.06, 0.06]} size={[0.05, 0.5, 0.24]} color={color} />
        </>
      ) : person.longHair === false ? (
        <Block position={[0, 0.1, 0.19]} size={[0.38, 0.14, 0.05]} color={color} />
      ) : (
        <Block position={[0, 0.04, 0.19]} size={[0.4, 0.3, 0.06]} color={color} />
      )}
    </>
  );
}

/** A voxel person, seated, facing −Z (the monitor), typing. */
function Person({ person, x, z, accent }: { person: OfficePerson; x: number; z: number; accent: string }) {
  const h = hash(person.id);
  const { shirt, pants } = clothesOf(person);
  const skin = SKIN[(h >>> 6) % SKIN.length];
  const hair = HAIR[(h >>> 9) % HAIR.length];
  const gem = person.longShift ? "#f7b733" : "#3ee07a";

  const arms = useRef<Group>(null);
  const head = useRef<Group>(null);
  const plumbob = useRef<Mesh>(null);
  const phase = (h % 100) / 10;

  useFrame(({ clock }) => {
    const t = clock.elapsedTime + phase;
    // Stepped, not smooth: pixel art moves in whole steps.
    if (arms.current) arms.current.position.y = Math.floor(t * 7) % 2 ? 0.025 : 0;
    if (head.current) head.current.rotation.y = Math.floor(t * 0.5) % 3 === 0 ? 0.25 : 0;
    if (plumbob.current) {
      plumbob.current.rotation.y = t * 1.6;
      plumbob.current.position.y = 2.05 + Math.round(Math.sin(t * 2) * 3) * 0.02;
    }
  });

  return (
    <group position={[x, 0, z]}>
      {/* Legs: thighs on the seat, shins down, shoes. */}
      <Block position={[0, 0.56, -0.14]} size={[0.44, 0.16, 0.5]} color={pants} />
      <Block position={[-0.11, 0.27, -0.36]} size={[0.18, 0.44, 0.18]} color={pants} />
      <Block position={[0.11, 0.27, -0.36]} size={[0.18, 0.44, 0.18]} color={pants} />
      <Block position={[-0.11, 0.05, -0.42]} size={[0.2, 0.1, 0.28]} color="#111827" />
      <Block position={[0.11, 0.05, -0.42]} size={[0.2, 0.1, 0.28]} color="#111827" />
      {/* Torso, collar, belt, and an ID lanyard in the department's colour. */}
      <Block position={[0, 0.93, 0.04]} size={[0.48, 0.56, 0.26]} color={shirt} />
      <Block position={[0, 1.19, 0.04]} size={[0.3, 0.06, 0.28]} color="#f8fafc" />
      <Block position={[0, 0.67, 0.04]} size={[0.5, 0.06, 0.28]} color="#3f2a1d" />
      <Block position={[-0.1, 1.02, -0.095]} size={[0.03, 0.3, 0.01]} color={accent} shadow={false} />
      <Block position={[0.1, 1.02, -0.095]} size={[0.03, 0.3, 0.01]} color={accent} shadow={false} />
      <Block position={[0, 0.84, -0.1]} size={[0.13, 0.17, 0.015]} color="#ffffff" shadow={false} />
      {/* Arms forward to the keyboard. */}
      <group ref={arms}>
        <Block position={[-0.31, 0.98, -0.14]} size={[0.14, 0.14, 0.44]} color={shirt} />
        <Block position={[0.31, 0.98, -0.14]} size={[0.14, 0.14, 0.44]} color={shirt} />
        <Block position={[-0.31, 0.98, -0.42]} size={[0.14, 0.14, 0.12]} color={skin} />
        <Block position={[0.31, 0.98, -0.42]} size={[0.14, 0.14, 0.12]} color={skin} />
      </group>
      {/* Head, hair, eyes. */}
      <group ref={head} position={[0, 1.4, 0.02]}>
        <Block position={[0, 0, 0]} size={[0.36, 0.36, 0.36]} color={skin} />
        <Hair person={person} color={hair} />
        <Block position={[-0.08, 0.02, -0.185]} size={[0.06, 0.06, 0.02]} color="#111111" />
        <Block position={[0.08, 0.02, -0.185]} size={[0.06, 0.06, 0.02]} color="#111111" />
      </group>
      {/* The plumbob. */}
      <mesh ref={plumbob} position={[0, 2.05, 0]} scale={[1, 1.7, 1]}>
        <octahedronGeometry args={[0.13, 0]} />
        <meshStandardMaterial color={gem} emissive={gem} emissiveIntensity={0.5} flatShading />
      </mesh>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Desks                                                                        */
/* -------------------------------------------------------------------------- */

function Desk({
  desk,
  accent,
  hovered,
  openable,
  onHover,
  onSelect,
}: {
  desk: OfficeDesk;
  /** Whether a click opens their DTR — the viewer may not read everyone's. */
  openable: boolean;
  /** The department's colour: lanyards, mugs. */
  accent: string;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onSelect: (person: OfficePerson) => void;
}) {
  const { x, y: z, person } = desk;
  const working = person.status === "working";
  const cx = x + 1.1;
  // Two things on each desk, the same two every day for the same person.
  const h = hash(person.id);
  const left = DESK_ITEMS[h % DESK_ITEMS.length];
  const right = DESK_ITEMS[(h >>> 4) % DESK_ITEMS.length];

  return (
    <group
      onPointerOver={(event: ThreeEvent<PointerEvent>) => {
        if (person.hidden) return;
        event.stopPropagation();
        onHover(person.id);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        if (person.hidden) return;
        onHover(null);
        document.body.style.cursor = "";
      }}
      onClick={(event: ThreeEvent<MouseEvent>) => {
        if (person.hidden) return;
        event.stopPropagation();
        // A drag that ends on a desk is the camera moving, not a click.
        if (event.delta > 4) return;
        onSelect(person);
      }}
    >
      {/* Hover marker on the floor. */}
      <mesh position={[cx, 0.07, z + 1.2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[2.7, 3]} />
        <meshBasicMaterial color="#facc15" transparent opacity={hovered ? 0.35 : 0} depthWrite={false} />
      </mesh>

      {/* Desk: white top, grey side panels. */}
      <Block position={[cx, 0.74, z + 0.5]} size={[2.2, 0.08, 1]} color="#f5f4f0" />
      <Block position={[x + 0.06, 0.36, z + 0.5]} size={[0.1, 0.72, 0.95]} color="#d4d2cc" />
      <Block position={[x + 2.14, 0.36, z + 0.5]} size={[0.1, 0.72, 0.95]} color="#d4d2cc" />
      {/* A drawer pedestal under the right end, and a modesty panel. */}
      <Block position={[x + 1.75, 0.34, z + 0.45]} size={[0.6, 0.68, 0.8]} color="#e7e5e4" />
      {[0.18, 0.4, 0.6].map((dy) => (
        <Block key={dy} position={[x + 1.75, dy, z + 0.86]} size={[0.2, 0.03, 0.02]} color="#78716c" shadow={false} />
      ))}
      <Block position={[cx, 0.45, z + 0.06]} size={[2.1, 0.5, 0.04]} color="#d4d2cc" />

      {/* Monitor: dark frame, the screen lit while somebody works. */}
      <Block position={[cx, 0.92, z + 0.22]} size={[0.1, 0.28, 0.1]} color="#2b2d38" />
      <Block position={[cx, 1.24, z + 0.18]} size={[1.15, 0.66, 0.08]} color="#2b2d38" />
      <Block
        position={[cx, 1.24, z + 0.225]}
        size={[1.02, 0.54, 0.01]}
        color={working ? "#7dd3fc" : "#3b4252"}
        emissive={working ? "#7dd3fc" : "#000000"}
        emissiveIntensity={working ? 0.6 : 0}
      />
      <Block position={[cx, 0.8, z + 0.62]} size={[0.8, 0.03, 0.24]} color="#d9dde3" />
      <Block position={[cx + 0.55, 0.795, z + 0.64]} size={[0.24, 0.005, 0.2]} color="#1f2937" shadow={false} />
      <Block position={[cx + 0.55, 0.81, z + 0.64]} size={[0.07, 0.03, 0.11]} color="#e5e7eb" />
      <DeskItem kind={left} x={x + 0.3} z={z + 0.35} tint={accent} on={working} />
      <DeskItem kind={right} x={x + 1.95} z={z + 0.3} tint={accent} on={working} />
      {person.status === "leave" ? (
        <Block position={[x + 0.4, 0.8, z + 0.6]} size={[0.3, 0.02, 0.3]} color="#fde68a" />
      ) : null}

      {/* Chair. Pushed in with its back showing when nobody is in it. */}
      <Block position={[cx, 0.24, z + 1.6]} size={[0.08, 0.4, 0.08]} color="#2a2f3a" />
      {/* Five-star base on castors. */}
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i * Math.PI * 2) / 5;
        return (
          <Block
            key={i}
            position={[cx + Math.cos(a) * 0.16, 0.05, z + 1.6 + Math.sin(a) * 0.16]}
            size={[0.32, 0.04, 0.05]}
            rotation={[0, -a, 0]}
            color="#2a2f3a"
          />
        );
      })}
      <Block position={[cx, 0.46, z + 1.6]} size={[0.58, 0.08, 0.58]} color="#3e4757" />
      <Block position={[cx - 0.31, 0.62, z + 1.62]} size={[0.05, 0.05, 0.4]} color="#2a2f3a" />
      <Block position={[cx + 0.31, 0.62, z + 1.62]} size={[0.05, 0.05, 0.4]} color="#2a2f3a" />
      <Block position={[cx, 0.82, z + 1.88]} size={[0.58, 0.64, 0.08]} color="#3e4757" />

      {/* Somebody who is in is drawn by `Occupant` — they move. An empty desk
          carries its owner's name and hover card itself. */}
      {working || person.hidden || person.roams ? null : (
        <>
          <group position={[cx, 0, z + 1.6]}>
            <NameTag position={[0, 1.3, 0]} name={person.name} dim />
            {hovered ? <HoverCard person={person} y={1.9} openable={openable} /> : null}
          </group>
        </>
      )}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                       */
/* -------------------------------------------------------------------------- */

function HoverCard({ person, y, note, openable }: { person: OfficePerson; y: number; note?: string; openable: boolean }) {
  return (
    <Html position={[0, y, 0]} center distanceFactor={14} zIndexRange={[30, 20]} style={{ pointerEvents: "none" }}>
      <div className="w-max max-w-64 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg">
        <p className="font-semibold">{person.name}</p>
        <p className="text-muted-foreground">{describeOfficePerson(person)}</p>
        {note ? <p className="text-muted-foreground">{note}</p> : null}
        {person.longShift ? <p className="text-warning">Still timed in — forgot to time out?</p> : null}
        {openable ? <p className="mt-0.5 text-2xs text-muted-foreground">Click to open their DTR</p> : null}
      </div>
    </Html>
  );
}

/* -------------------------------------------------------------------------- */
/* People on the move                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A person standing up — walking, or at the podium. Legs and arms hang from
 * hip and shoulder pivots so they can swing. Faces −Z in its own frame.
 */
function StandingPerson({
  person,
  accent,
  legs,
  arms,
  cigarette,
}: {
  person: OfficePerson;
  accent: string;
  legs: React.RefObject<(Group | null)[]>;
  arms: React.RefObject<(Group | null)[]>;
  /** Held in the right hand, shown by whoever owns the ref. */
  cigarette?: React.RefObject<Group | null>;
}) {
  const h = hash(person.id);
  const { shirt, pants } = clothesOf(person);
  const skin = SKIN[(h >>> 6) % SKIN.length];
  const hair = HAIR[(h >>> 9) % HAIR.length];
  const gem = person.longShift ? "#f7b733" : "#3ee07a";

  return (
    <group>
      {[-0.11, 0.11].map((lx, i) => (
        <group
          key={lx}
          position={[lx, 0.78, 0]}
          ref={(node) => {
            legs.current[i] = node;
          }}
        >
          <Block position={[0, -0.36, 0]} size={[0.18, 0.72, 0.2]} color={pants} />
          <Block position={[0, -0.73, -0.05]} size={[0.2, 0.1, 0.3]} color="#111827" />
        </group>
      ))}
      <Block position={[0, 1.06, 0]} size={[0.48, 0.56, 0.26]} color={shirt} />
      <Block position={[0, 1.32, 0]} size={[0.3, 0.06, 0.28]} color="#f8fafc" />
      <Block position={[0, 0.8, 0]} size={[0.5, 0.06, 0.28]} color="#3f2a1d" />
      <Block position={[-0.1, 1.15, -0.135]} size={[0.03, 0.3, 0.01]} color={accent} shadow={false} />
      <Block position={[0.1, 1.15, -0.135]} size={[0.03, 0.3, 0.01]} color={accent} shadow={false} />
      <Block position={[0, 0.97, -0.14]} size={[0.13, 0.17, 0.015]} color="#ffffff" shadow={false} />
      {[-0.31, 0.31].map((ax, i) => (
        <group
          key={ax}
          position={[ax, 1.3, 0]}
          ref={(node) => {
            arms.current[i] = node;
          }}
        >
          <Block position={[0, -0.25, 0]} size={[0.14, 0.5, 0.14]} color={shirt} />
          <Block position={[0, -0.55, 0]} size={[0.14, 0.12, 0.14]} color={skin} />
          {i === 1 && cigarette ? (
            <group ref={cigarette} visible={false}>
              <Block position={[0, -0.62, -0.09]} size={[0.025, 0.025, 0.16]} color="#f8fafc" shadow={false} />
              <Block position={[0, -0.62, -0.175]} size={[0.03, 0.03, 0.02]} color="#f97316" emissive="#f97316" emissiveIntensity={1.2} shadow={false} />
            </group>
          ) : null}
        </group>
      ))}
      <group position={[0, 1.55, 0]}>
        <Block position={[0, 0, 0]} size={[0.36, 0.36, 0.36]} color={skin} />
        <Hair person={person} color={hair} />
        <Block position={[-0.08, 0.02, -0.185]} size={[0.06, 0.06, 0.02]} color="#111111" />
        <Block position={[0.08, 0.02, -0.185]} size={[0.06, 0.06, 0.02]} color="#111111" />
      </group>
      <mesh position={[0, 2.2, 0]} scale={[1, 1.7, 1]}>
        <octahedronGeometry args={[0.13, 0]} />
        <meshStandardMaterial color={gem} emissive={gem} emissiveIntensity={0.5} flatShading />
      </mesh>
    </group>
  );
}

type Point = [number, number];

/** The treadmills and bikes, as drawn by `Gym`: x from the lounge's left, z from the gym's start. */
const GYM_MACHINES: { x: number; z: number; does: "run" | "bike" }[] = [
  { x: 1.2, z: 1.4, does: "run" },
  { x: 3.7, z: 1.62, does: "bike" },
  { x: 2.3, z: 1.4, does: "run" },
  { x: 4.6, z: 1.62, does: "bike" },
];

/** How fast people walk, units a second. A little quicker than the cat. */
const WALK_SPEED = 1.4;
/** One draw and one breath out, in seconds. */
const DRAG = 9;

type Trip = ReturnType<typeof timeline>;

/** Where a leg of a trip puts somebody at `t`, and which way they face. */
function onLeg(leg: Leg, t: number): { x: number; z: number; facing: number; walking: boolean } {
  if ("at" in leg) return { x: leg.at[0], z: leg.at[1], facing: leg.facing, walking: false };
  const k = (t - leg.start) / (leg.end - leg.start);
  return {
    x: leg.from[0] + (leg.to[0] - leg.from[0]) * k,
    z: leg.from[1] + (leg.to[1] - leg.from[1]) * k,
    facing: Math.atan2(-(leg.to[0] - leg.from[0]), -(leg.to[1] - leg.from[1])),
    walking: true,
  };
}

function legAt(trip: Trip, t: number): Leg | undefined {
  return trip.legs.find((candidate) => t >= candidate.start && t < candidate.end) ?? trip.legs[trip.legs.length - 1];
}

type Parts = React.RefObject<(Group | null)[]>;

function swingLimbs(legs: Parts, arms: Parts, swing: number) {
  legs.current.forEach((part, i) => {
    if (part) part.rotation.x = i ? -swing : swing;
  });
  arms.current.forEach((part, i) => {
    if (part) part.rotation.x = i ? swing * 0.7 : -swing * 0.7;
  });
}

/** Hand up to the mouth for a third of the time, then a slow breath out. */
function smokeBeat(t: number, arms: Parts, puff: Mesh | null) {
  const beat = t % DRAG;
  if (arms.current[1]) arms.current[1].rotation.x = beat < DRAG / 3 ? 2.2 : 0.3;
  if (puff && beat >= DRAG / 3 && beat < (DRAG * 2) / 3) {
    const k = (beat - DRAG / 3) / (DRAG / 3);
    puff.visible = true;
    puff.position.set(0, 1.55 + k * 0.8, -0.3 - k * 0.15);
    puff.scale.setScalar(1 + k * 2.5);
  }
}

function Puff({ meshRef }: { meshRef: React.RefObject<Mesh | null> }) {
  return (
    <mesh ref={meshRef} visible={false}>
      <boxGeometry args={[0.14, 0.14, 0.14]} />
      <meshStandardMaterial color="#e5e7eb" transparent opacity={0.55} depthWrite={false} />
    </mesh>
  );
}

/** A seat somebody is in away from their desk, and why. */
type AwaySeat = Seat & { where: "lunch" | "allhands" };

/** Hover and click on a figure that moves. */
function personEvents(
  person: OfficePerson,
  onHover: (id: string | null) => void,
  onSelect: (person: OfficePerson) => void,
) {
  return {
    onPointerOver: (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      onHover(person.id);
      document.body.style.cursor = "pointer";
    },
    onPointerOut: () => {
      onHover(null);
      document.body.style.cursor = "";
    },
    onClick: (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      if (event.delta > 4) return;
      onSelect(person);
    },
  };
}

/**
 * Somebody's working day away from the desk: their turn at the comfort room, and
 * between turns one other trip — the water, the printer, the canteen, the gym, a
 * smoke. `bathroomArrive` is when, in each `period`, they reach the door.
 */
type Routine = { period: number; bathroomArrive: number; bathroom: Trip; others: Trip[] };

/**
 * Somebody who is in, wherever they are right now:
 * - lunch, with a seat  → at the canteen;
 * - the all-hands       → in a chair, or at the podium if `presenting`;
 * - otherwise           → at their desk, getting up for their `routine`.
 *
 * Where they are is decided per frame from the clock and their turn, so it costs
 * no re-render: the sitting and the walking figure are both mounted and swap
 * visibility, and the name tag follows whichever is showing.
 */
function Occupant({
  person,
  accent,
  chair,
  routine,
  smoker,
  seat,
  presenting,
  hovered,
  openable,
  onHover,
  onSelect,
}: {
  person: OfficePerson;
  accent: string;
  openable: boolean;
  /** The desk chair, where they sit when nothing else is on. */
  chair: Point;
  routine: Routine | null;
  smoker: boolean;
  /** A seat elsewhere — the canteen at lunch, the all-hands on Friday. */
  seat: AwaySeat | null;
  presenting: boolean;
  hovered: boolean;
  onHover: (id: string | null) => void;
  onSelect: (person: OfficePerson) => void;
}) {
  const h = hash(person.id);
  const moves = !seat && !presenting && routine !== null;
  // How long they stay at their desk after the comfort room, before the other trip.
  const pause = 20 + (h % 60);

  const sitting = useRef<Group>(null);
  const walking = useRef<Group>(null);
  const tag = useRef<Group>(null);
  const legs = useRef<(Group | null)[]>([]);
  const arms = useRef<(Group | null)[]>([]);
  const cigarette = useRef<Group>(null);
  const puff = useRef<Mesh>(null);

  useFrame(({ clock }) => {
    const time = clock.elapsedTime;

    if (presenting) {
      // A hand up now and then, making a point.
      const raise = Math.floor(time * 0.8) % 3 === 0;
      if (arms.current[1]) arms.current[1].rotation.x = raise ? -1.9 + Math.sin(time * 4) * 0.2 : -0.2;
      return;
    }
    if (!moves || !routine || !sitting.current || !walking.current || !tag.current) return;

    // Each period starts as they leave for the comfort room, so they reach the
    // door exactly on their turn.
    const walkThere = routine.bathroom.legs.find((leg) => "at" in leg)?.start ?? 0;
    const since = time - (routine.bathroomArrive - walkThere);
    const cycle = Math.floor(since / routine.period);
    const into = since - cycle * routine.period;

    let trip: Trip | null = null;
    let t = 0;
    if (into < routine.bathroom.total) {
      trip = routine.bathroom;
      t = into;
    } else {
      const other = routine.others[(cycle + h) % routine.others.length];
      const later = into - routine.bathroom.total - pause;
      if (other && later >= 0 && later < other.total) {
        trip = other;
        t = later;
      }
    }

    if (cigarette.current) cigarette.current.visible = false;
    if (puff.current) puff.current.visible = false;
    tag.current.visible = true;

    const leg = trip ? legAt(trip, t) : undefined;
    if (!leg) {
      sitting.current.visible = true;
      walking.current.visible = false;
      sitting.current.position.set(chair[0], 0, chair[1]);
      sitting.current.rotation.y = 0;
      tag.current.position.set(chair[0], 0, chair[1]);
      return;
    }

    const at = onLeg(leg, t);
    const does = "at" in leg ? leg.does : undefined;
    const seated = does === "sit";
    sitting.current.visible = seated;
    walking.current.visible = !seated && does !== "inside";
    tag.current.visible = does !== "inside";
    tag.current.position.set(at.x, seated ? 0 : 0.15, at.z);

    if (seated) {
      sitting.current.position.set(at.x, 0, at.z);
      sitting.current.rotation.y = at.facing;
      return;
    }

    walking.current.position.set(at.x, 0, at.z);
    walking.current.rotation.y = at.facing;
    swingLimbs(legs, arms, at.walking ? Math.sin(time * 9) * 0.55 : 0);

    if (does === "smoke") {
      if (cigarette.current) cigarette.current.visible = true;
      smokeBeat(t - leg.start, arms, puff.current);
    }
    if (does === "curl") {
      // Dumbbell curls, both arms together.
      const curl = 1.3 + Math.sin(time * 3) * 1;
      arms.current.forEach((arm) => {
        if (arm) arm.rotation.x = curl;
      });
    }
    if (does === "squat") {
      // Down and up: the hips drop and move back, knees forward, arms out for balance.
      const k = (Math.sin(time * 2.5) + 1) / 2;
      const back = 0.3 * k;
      walking.current.position.set(at.x + Math.sin(at.facing) * back, -0.35 * k, at.z + Math.cos(at.facing) * back);
      legs.current.forEach((leg) => {
        if (leg) leg.rotation.x = k;
      });
      arms.current.forEach((arm) => {
        if (arm) arm.rotation.x = 1.5 * k;
      });
    }
    if (does === "run") {
      // On the treadmill's belt.
      walking.current.position.y = 0.22;
      swingLimbs(legs, arms, Math.sin(time * 14) * 0.8);
    }
    if (does === "bike") {
      // On the saddle, pedalling, hands on the bars.
      walking.current.position.y = 0.28;
      const pedal = Math.sin(time * 6) * 0.45;
      legs.current.forEach((leg, i) => {
        if (leg) leg.rotation.x = 1 + (i ? -pedal : pedal);
      });
      arms.current.forEach((arm) => {
        if (arm) arm.rotation.x = 1.2;
      });
    }
  });

  const note = presenting
    ? "Presenting at the all-hands"
    : seat
      ? seat.where === "lunch"
        ? "At lunch, in the canteen"
        : "At the Friday all-hands"
      : undefined;
  const spot: Point = seat ? [seat.x, seat.z] : chair;

  return (
    <group {...personEvents(person, onHover, onSelect)}>
      {presenting && seat ? (
        <group position={[seat.x, 0.24, seat.z]} rotation={[0, seat.facing, 0]}>
          <StandingPerson person={person} accent={accent} legs={legs} arms={arms} />
        </group>
      ) : (
        <>
          <group ref={sitting} position={[spot[0], 0, spot[1]]} rotation={[0, seat ? seat.facing : 0, 0]}>
            <Person person={person} x={0} z={0} accent={accent} />
          </group>
          {moves ? (
            <group ref={walking} visible={false}>
              <StandingPerson person={person} accent={accent} legs={legs} arms={arms} cigarette={smoker ? cigarette : undefined} />
              {smoker ? <Puff meshRef={puff} /> : null}
            </group>
          ) : null}
        </>
      )}

      <group ref={tag} position={[spot[0], presenting ? 0.4 : 0, spot[1]]}>
        <NameTag position={[0, 2.5, 0]} name={person.name} />
        {hovered ? <HoverCard person={person} y={3.1} note={note} openable={openable} /> : null}
      </group>
    </group>
  );
}

/**
 * The two walks from a desk: back out of the chair into the aisle, along it to
 * the corridor right of the desks, then up to the water dispenser — or on along
 * the back to the printer. Kept to the gaps between furniture.
 */
function routes(room: OfficeRoom, desk: OfficeDesk): [Point[], Point[]] {
  const chair: Point = [desk.x + 1.1, desk.y + 1.6];
  const aisle = desk.y + 2.55;
  const corridor = room.x + 9.6;
  return [
    [chair, [chair[0], aisle], [corridor, aisle], [corridor, room.y + 1.3]],
    [chair, [chair[0], aisle], [corridor, aisle], [corridor, room.y + 1.75], [room.x + room.w - 2.6, room.y + 1.75]],
  ];
}

/**
 * Somebody who does not need to time in, walking the floor (P17-13): the corridors,
 * the rooms this viewer can see into, the canteen and the gym. A smoker's loop also
 * goes out of the fire exit to the smoking area.
 *
 * Where they are comes from the clock and their id, like the cat and `Occupant`,
 * so it costs no re-render. Starting partway round by id keeps two roamers from
 * walking in step.
 */
function Roamer({
  person,
  accent,
  stops,
  smoker,
  hovered,
  openable,
  onHover,
  onSelect,
}: {
  person: OfficePerson;
  accent: string;
  stops: CatStop[];
  smoker: boolean;
  hovered: boolean;
  openable: boolean;
  onHover: (id: string | null) => void;
  onSelect: (person: OfficePerson) => void;
}) {
  const trip = useMemo(() => timeline(stops, WALK_SPEED), [stops]);
  const offset = hash(person.id);

  const root = useRef<Group>(null);
  const tag = useRef<Group>(null);
  const legs = useRef<(Group | null)[]>([]);
  const arms = useRef<(Group | null)[]>([]);
  const cigarette = useRef<Group>(null);
  const puff = useRef<Mesh>(null);

  useFrame(({ clock }) => {
    if (!root.current || !tag.current || trip.total <= 0) return;
    const time = clock.elapsedTime;
    const t = (time + offset) % trip.total;
    const leg = legAt(trip, t);
    if (!leg) return;

    const at = onLeg(leg, t);
    root.current.position.set(at.x, 0, at.z);
    root.current.rotation.y = at.facing;
    tag.current.position.set(at.x, 0.15, at.z);
    swingLimbs(legs, arms, at.walking ? Math.sin(time * 9) * 0.55 : 0);

    const smoking = "at" in leg && leg.does === "smoke";
    if (cigarette.current) cigarette.current.visible = smoking;
    if (puff.current) puff.current.visible = false;
    if (smoking) smokeBeat(t - leg.start, arms, puff.current);
  });

  return (
    <group {...personEvents(person, onHover, onSelect)}>
      <group ref={root}>
        <StandingPerson person={person} accent={accent} legs={legs} arms={arms} cigarette={smoker ? cigarette : undefined} />
        {smoker ? <Puff meshRef={puff} /> : null}
      </group>
      <group ref={tag}>
        <NameTag position={[0, 2.5, 0]} name={person.name} />
        {hovered ? (
          <HoverCard
            person={person}
            y={3.1}
            note={smoker ? "Walking the floor, or out at the smoking area. No time-in needed." : "Walking the floor. No time-in needed."}
            openable={openable}
          />
        ) : null}
      </group>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Rooms and the lounge                                                         */
/* -------------------------------------------------------------------------- */

function Plant({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.22, 0]} size={[0.45, 0.44, 0.45]} color="#b5672c" />
      <Block position={[0, 0.7, 0]} size={[0.65, 0.55, 0.65]} color="#4caf50" />
      <Block position={[0, 1.08, 0]} size={[0.4, 0.3, 0.4]} color="#6cc46f" />
    </group>
  );
}

function Shelf({ x, z }: { x: number; z: number }) {
  const books = ["#e25d5d", "#4f7cff", "#f2a33a", "#2fb67c", "#9b6bff", "#e86fb0"];
  return (
    <group position={[x, 0, z]}>
      <Block position={[1.1, 0.85, 0.25]} size={[2.2, 1.7, 0.5]} color="#8d6e63" />
      {[0.55, 1.15].flatMap((y) =>
        books.map((color, i) => (
          <Block key={`${y}-${i}`} position={[0.3 + i * 0.32, y, 0.52]} size={[0.22, 0.4 + (i % 2) * 0.08, 0.04]} color={color} />
        )),
      )}
    </group>
  );
}

/**
 * A room the viewer may not look into (P17-07): another department's, seen by
 * a member. Walls that never cut away, a roof, the doors shut, and the sign —
 * the floor plan stays whole, and nothing inside is drawn at all.
 */
function ClosedRoom({ room, accent }: { room: OfficeRoom; accent: string }) {
  const { x, y: z, w, d } = room;
  const H = 1.7;
  const T = 0.18;
  const door = 1.8;
  const half = (w - door) / 2;
  const wall = "#e7e2d9";
  return (
    <group>
      <Block position={[x + w / 2, H / 2, z + T / 2]} size={[w, H, T]} color={wall} />
      <Block position={[x + T / 2, H / 2, z + d / 2]} size={[T, H, d]} color={wall} />
      <Block position={[x + w - T / 2, H / 2, z + d / 2]} size={[T, H, d]} color={wall} />
      <Block position={[x + half / 2, H / 2, z + d - T / 2]} size={[half, H, T]} color={wall} />
      <Block position={[x + w - half / 2, H / 2, z + d - T / 2]} size={[half, H, T]} color={wall} />
      {/* The doors, shut. */}
      <Block position={[x + w / 2, 0.76, z + d - T / 2]} size={[door, 1.52, 0.1]} color="#a16207" />
      <Block position={[x + w / 2, 0.76, z + d - T / 2]} size={[0.03, 1.52, 0.12]} color="#78350f" />
      <Block position={[x + w / 2 - 0.15, 0.78, z + d - T / 2 + 0.07]} size={[0.04, 0.16, 0.04]} color="#d1d5db" />
      <Block position={[x + w / 2 + 0.15, 0.78, z + d - T / 2 + 0.07]} size={[0.04, 0.16, 0.04]} color="#d1d5db" />
      <Block position={[x + w / 2, 1.6, z + d - T / 2]} size={[door + 0.2, 0.18, 0.2]} color="#78350f" />
      {/* The roof, its edge in the department's colour. */}
      <Block position={[x + w / 2, H + 0.04, z + d / 2]} size={[w, 0.08, d]} color="#d6d3d1" />
      <Block position={[x + w / 2, H + 0.09, z + d / 2]} size={[w - 0.4, 0.02, d - 0.4]} color="#e7e5e4" shadow={false} />
      <Block position={[x + w / 2, H + 0.1, z + 0.12]} size={[w, 0.04, 0.24]} color={accent} shadow={false} />
      <Block position={[x + w / 2, H + 0.1, z + d - 0.12]} size={[w, 0.04, 0.24]} color={accent} shadow={false} />
      <Block position={[x + 0.12, H + 0.1, z + d / 2]} size={[0.24, 0.04, d]} color={accent} shadow={false} />
      <Block position={[x + w - 0.12, H + 0.1, z + d / 2]} size={[0.24, 0.04, d]} color={accent} shadow={false} />

      {/* The sign, over the doors at the front — the same as an open room's,
          with PRIVATE where the count would be. */}
      <Sign position={[x + w / 2, H + 0.95, z + d]} title={room.name.toUpperCase()} subtitle="PRIVATE" color={accent} height={SIGN_H} />
    </group>
  );
}

function Room({
  room,
  hoveredId,
  canOpen,
  onHover,
  onSelect,
}: {
  room: OfficeRoom;
  hoveredId: string | null;
  canOpen: (id: string) => boolean;
  onHover: (id: string | null) => void;
  onSelect: (person: OfficePerson) => void;
}) {
  const colors = DEPT[room.colorIndex % DEPT.length];
  const { x, y: z, w, d } = room;

  // P17-07. Another department's room, to a member: closed, roof on.
  if (room.desks.length > 0 && room.desks.every((desk) => desk.person.hidden)) {
    return <ClosedRoom room={room} accent={colors.sign} />;
  }

  return (
    <group>
      {/* The department's carpet. */}
      <Block position={[x + w / 2, FLOOR_RUG, z + d / 2]} size={[w - 0.5, 0.04, d - 0.5]} color={colors.carpet} />

      {/* Its walls, and a back wall dressed for what the department does. */}
      <group position={[x, 0, z]}>
        <RoomWalls w={w} d={d} accent={colors.sign} theme={officeTheme(room.name)} />
      </group>

      {/* Along the back: the bookshelf and a water dispenser behind the desks,
          the printer at the back of the meeting corner, a plant in the corner. */}
      <Shelf x={x + 6} z={z + 0.3} />
      <WaterDispenser x={x + 9.2} z={z + 0.6} />
      <Printer x={x + w - 2.6} z={z + 0.75} />
      <Plant x={x + w - 0.7} z={z + 0.6} />

      {/* The meeting corner, right of the desks: projector, table, the screen on the right wall. */}
      <MeetingCorner x={x + w - AMENITY_W + 0.2} z={z + meetingDepth(d)} screenX={x + w - 0.2} />

      {room.desks.map((desk) => (
        <Desk
          key={desk.person.id}
          desk={desk}
          accent={colors.sign}
          hovered={hoveredId === desk.person.id}
          openable={canOpen(desk.person.id)}
          onHover={onHover}
          onSelect={onSelect}
        />
      ))}

      {/* The sign, over the doors at the front — the side the camera starts on,
          and where you would look for a room's name. */}
      <Sign
        height={SIGN_H}
        position={[x + w / 2, 2.65, z + d]}
        title={room.name.toUpperCase()}
        subtitle={`${room.counts.working}/${room.desks.length} IN`}
        color={colors.sign}
      />
    </group>
  );
}

/** The building: slab, wood floor and planks, and four windowed walls that cut away towards the camera. */
function Building({ width, depth }: { width: number; depth: number }) {
  const T = 0.3;
  const panes = (length: number) => Array.from({ length: Math.floor((length - 0.6) / 2.2) }, (_, i) => 0.6 + i * 2.2 + 0.85);

  return (
    <group>
      {/* ⚠️ THE SLAB'S TOP SITS UNDER THE FLOOR, NOT LEVEL WITH IT. Both tops at
          y = 0 is what flickered: two coplanar faces z-fight, the GPU flipping
          between them pixel by pixel as the camera moves — the floor looked
          like fairy lights whatever colour or pattern it was given. The slab now
          tops out at −0.01, inside the floor (−0.02 … 0), so only one face is
          ever at the surface. */}
      <Block position={[width / 2, -0.26, depth / 2]} size={[width + 2 * T, 0.5, depth + 2 * T]} color={SLAB} />
      {/* Wood deck tiles, as a texture — see `WoodFloor` for why that stops the flicker. */}
      <WoodFloor width={width} depth={depth} />

      {/* Four walls, each with windows, each dropping when the camera is outside it. */}
      <CutawayWall center={[width / 2, 0, -T / 2]} size={[width + 2 * T, T]} normal={[0, -1]} height={WALL_H} low={CUT_H}>
        {panes(width).map((px) => (
          <Window key={px} position={[px, 2.15, 0.02]} along="x" />
        ))}
      </CutawayWall>
      <CutawayWall center={[-T / 2, 0, depth / 2]} size={[T, depth + 2 * T]} normal={[-1, 0]} height={WALL_H} low={CUT_H}>
        {panes(depth).map((pz) => (
          <Window key={pz} position={[0.02, 2.15, pz]} along="z" />
        ))}
      </CutawayWall>
      <CutawayWall center={[width + T / 2, 0, depth / 2]} size={[T, depth + 2 * T]} normal={[1, 0]} height={WALL_H} low={CUT_H}>
        {panes(depth).map((pz) => (
          <Window key={pz} position={[width - 0.02, 2.15, pz]} along="z" />
        ))}
      </CutawayWall>
      <CutawayWall center={[width / 2, 0, depth + T / 2]} size={[width + 2 * T, T]} normal={[0, 1]} height={WALL_H} low={CUT_H}>
        {panes(width).map((px) => (
          <Window key={px} position={[px, 2.15, depth - 0.02]} along="x" />
        ))}
      </CutawayWall>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Camera                                                                       */
/* -------------------------------------------------------------------------- */

type CameraApi = { zoom: (factor: number) => void; reset: () => void; turn: (radians: number) => void };

/** Hands the zoom and reset buttons — which live outside the canvas — a way in. */
function CameraBridge({
  apiRef,
  controlsRef,
  bounds,
}: {
  apiRef: React.RefObject<CameraApi | null>;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  /** Half the floor's width and depth: the camera's target never leaves it. */
  bounds: { x: number; z: number };
}) {
  const camera = useThree((state) => state.camera);
  /** Radians still to turn — the buttons and Q/E add to it, frames spend it. */
  const turning = useRef(0);

  // Panning can reach every corner, but not past the walls into nothing: the
  // target is clamped to the floor, and the camera is moved by the same amount
  // so the clamp reads as a stop, not a swing.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const clamp = () => {
      const t = controls.target;
      const x = Math.max(-bounds.x, Math.min(bounds.x, t.x));
      const z = Math.max(-bounds.z, Math.min(bounds.z, t.z));
      if (x === t.x && z === t.z && t.y === 0) return;
      camera.position.x += x - t.x;
      camera.position.z += z - t.z;
      camera.position.y -= t.y;
      t.set(x, 0, z);
    };
    controls.addEventListener("change", clamp);
    return () => controls.removeEventListener("change", clamp);
  }, [bounds.x, bounds.z, camera, controlsRef]);
  useEffect(() => {
    apiRef.current = {
      zoom(factor) {
        const target = controlsRef.current?.target ?? new Vector3();
        const offset = camera.position.clone().sub(target).multiplyScalar(1 / factor);
        camera.position.copy(target.clone().add(offset));
        controlsRef.current?.update();
      },
      reset() {
        turning.current = 0;
        controlsRef.current?.reset();
      },
      turn(radians) {
        turning.current += radians;
      },
    };
  }, [apiRef, camera, controlsRef]);

  useFrame(() => {
    const left = turning.current;
    if (Math.abs(left) < 0.0005) return;
    const step = Math.abs(left) < 0.01 ? left : left * 0.18;
    turning.current -= step;
    const target = controlsRef.current?.target;
    if (!target) return;
    const offset = camera.position.clone().sub(target);
    offset.applyAxisAngle(UP, step);
    camera.position.copy(target).add(offset);
    controlsRef.current?.update();
  });
  return null;
}

/* -------------------------------------------------------------------------- */
/* The scene                                                                    */
/* -------------------------------------------------------------------------- */

export function Office3D({
  layout,
  activity,
  onSelect,
  canOpen = () => true,
  className,
}: {
  layout: OfficeLayout;
  /** The scene's height — shorter on the dashboard than on /dtr. */
  className?: string;
  /** Whose DTR a click may open. Everyone's for a lead; a member's own only. */
  canOpen?: (id: string) => boolean;
  /** Desks, lunch, or the Friday all-hands — from `officeActivity`, by the clock in Manila. */
  activity: OfficeActivity;
  onSelect: (person: OfficePerson) => void;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const controls = useRef<OrbitControlsImpl | null>(null);
  const api = useRef<CameraApi | null>(null);

  // The rooms, then the all-hands room under them, full width; the lounge to the right.
  const roomsW = Math.max(layout.width, ROOM_W);
  const everyone = layout.rooms.flatMap((room) => room.desks.map((desk) => ({ room, desk })));
  const hallZ = layout.rooms.length > 0 ? layout.depth + HALL : 0;
  // The all-hands room: just wide enough for its 30 chairs, at the left, under the rooms.
  const hallW = Math.min(roomsW, HALL_W);
  const hall = townHallSize(everyone.length, hallW);
  const loungeX = roomsW + HALL;
  const totalW = loungeX + LOUNGE_W;
  const depth = Math.max(hallZ + hall.d, MIN_DEPTH);
  const reach = Math.max(totalW, depth);

  // Who sits where away from their desk: the canteen at lunch, the all-hands on
  // Friday — the first person (by id) presents from the podium.
  const inIds = everyone.filter(({ desk }) => desk.person.status === "working").map(({ desk }) => desk.person.id);
  const inKey = inIds.join(",");
  const { away, presenter } = useMemo(() => {
    const seats = new Map<string, AwaySeat>();
    let first: string | null = null;
    const ids = inKey ? inKey.split(",") : [];
    if (activity === "lunch") {
      const span = canteenSpan(depth);
      assignSeats(ids, canteenSeats(loungeX, span.from, span.to)).forEach((seat, id) => seats.set(id, { ...seat, where: "lunch" }));
    }
    if (activity === "allhands" && ids.length > 0) {
      const sorted = [...ids].sort();
      first = sorted[0];
      seats.set(first, { ...podium(0, hallZ, hallW), where: "allhands" });
      assignSeats(sorted.slice(1), townHallSeats(0, hallZ, hallW, everyone.length)).forEach((seat, id) =>
        seats.set(id, { ...seat, where: "allhands" }),
      );
    }
    return { away: seats, presenter: first };
  }, [activity, depth, everyone.length, hallW, hallZ, inKey, loungeX]);

  // The main entrance: in the front wall, in the free corridor right of the
  // all-hands room — or mid-lounge if there is no such corridor.
  const entranceX = roomsW - hallW > 4 ? hallW + (roomsW - hallW) / 2 : loungeX + LOUNGE_W / 2;

  // The cat's day: every department room, with the canteen and the gym in
  // between — the long stays. Routes keep to the corridors: along the main one
  // between the rooms and the lounge, then along the hall in front of a row of
  // rooms, through the door, and to the water dispenser inside.
  const spine = roomsW + HALL / 2;
  const floorTour = useCallback((visit: OfficeRoom[]): CatStop[] => {
    const rooms: CatStop[] = visit.map((room) => {
      const hall = room.y + room.d + HALL / 2;
      const door = room.x + room.w / 2;
      const inside = room.y + room.d - 0.6;
      const aisle = room.x + 9.6;
      return {
        route: [[spine, hall], [door, hall], [door, inside], [aisle, inside], [aisle, room.y + 1.4]],
        stay: 12,
      };
    });
    const span = canteenSpan(depth);
    const canteen: CatStop = { route: [[spine, span.from + 2.6], [loungeX + 2.85, span.from + 2.6]], stay: 35 };
    const zone = gymZone(depth);
    const gym: CatStop | null = zone
      ? { route: [[spine, (zone.from + zone.to) / 2], [loungeX + 3.2, (zone.from + zone.to) / 2]], stay: 30 }
      : null;
    const lounge = [canteen, gym ?? canteen];
    // Every room shut to this viewer: the lounge still makes a walk.
    return rooms.length > 0 ? rooms.flatMap((room, i) => [room, lounge[i % 2]]) : lounge;
  }, [spine, loungeX, depth]);
  const catStops = useMemo(() => floorTour(layout.rooms), [floorTour, layout.rooms]);

  // The same walk for whoever roams, minus the rooms this viewer sees closed: a
  // figure inside one would be its name through the roof. A smoker's loop ends
  // out of the fire exit, on the far side of the door `FireExit` draws.
  const roamStops = useMemo(
    () => floorTour(layout.rooms.filter((room) => !room.desks.every((desk) => desk.person.hidden))),
    [floorTour, layout.rooms],
  );
  // Out of the fire exit onto the pad; `spot` keeps two smokers from standing in one place.
  const smokeStop = useCallback(
    (spot: number): CatStop => ({
      route: [[spine, FIRE_EXIT_Z], [totalW + 1, FIRE_EXIT_Z], [totalW + 1, FIRE_EXIT_Z + (spot % 3) * 0.6 - 0.3]],
      stay: 45,
      does: "smoke",
      facing: -Math.PI / 2,
    }),
    [spine, totalW],
  );
  const smokerStops = useMemo<CatStop[]>(() => [...roamStops, smokeStop(0)], [roamStops, smokeStop]);

  // Everybody at a desk who can be seen gets a routine; a hidden person is only
  // ever drawn in a seat, and a roamer has their own walk. Turns at the comfort
  // room go by id, so they do not reshuffle as the list is re-read.
  const routineUsers = everyone
    .filter(({ desk }) => desk.person.status === "working" && !desk.person.hidden && !desk.person.roams)
    .sort((a, b) => a.desk.person.id.localeCompare(b.desk.person.id));
  const routineKey = routineUsers.map(({ desk }) => desk.person.id).join(",");
  const routines = useMemo(() => {
    const span = canteenSpan(depth);
    const seats = canteenSeats(loungeX, span.from, span.to);
    const zone = gymZone(depth);
    const count = routineUsers.length;
    const out = new Map<string, Routine>();

    routineUsers.forEach(({ room, desk }, index) => {
      // Out of the desks, through the room's door, along its hall to the main corridor.
      const [water, printer] = routes(room, desk);
      const chair = water[0];
      const inside = room.y + room.d - 0.6;
      const door = room.x + room.w / 2;
      const hall = room.y + room.d + HALL / 2;
      const toCorridor: FloorPoint[] = [
        chair,
        [chair[0], desk.y + 2.55],
        [room.x + 9.6, desk.y + 2.55],
        [room.x + 9.6, inside],
        [door, inside],
        [door, hall],
        [spine, hall],
      ];
      const trip = (stop: CatStop) => timeline([{ ...stop, route: [...toCorridor, ...stop.route] }], WALK_SPEED);

      const others: Trip[] = [
        timeline([{ route: water, stay: 6 }], WALK_SPEED),
        timeline([{ route: printer, stay: 6 }], WALK_SPEED),
      ];
      if (seats.length > 0) {
        const seat = seats[index % seats.length];
        others.push(trip({ route: [[spine, seat.z], [seat.x, seat.z]], stay: 40, does: "sit", facing: seat.facing }));
      }
      if (zone) {
        // The open row of the mat for squats and curls, then one of the machines,
        // walked up to from behind so they end up facing its console.
        const z = zone.from + 2.8;
        const mat: FloorPoint[] = [[spine, z], [loungeX + 1.2 + (index % 5) * 1.2, z]];
        others.push(trip({ route: mat, stay: 40, does: "squat" }), trip({ route: mat, stay: 40, does: "curl" }));
        const machine = GYM_MACHINES[index % GYM_MACHINES.length];
        const mx = loungeX + machine.x;
        const mz = zone.from + machine.z;
        others.push(trip({ route: [[spine, z], [mx, z], [mx, mz]], stay: 45, does: machine.does }));
      }
      if (isSmoker(desk.person)) {
        // Twice in the rotation: a smoker goes out more than they go to the gym.
        others.push(trip(smokeStop(index)), trip(smokeStop(index)));
      }

      out.set(desk.person.id, {
        period: bathroomPeriod(count),
        bathroomArrive: index * BATHROOM_SLOT,
        bathroom: trip({
          // To the end of the main corridor, and in through the door in the back wall.
          route: [[spine, 0.6], [spine, -1.6]],
          stay: BATHROOM_STAY,
          does: "inside",
        }),
        others,
      });
    });
    return out;
    // `routineUsers` is rebuilt every render; `routineKey` and the layout are what change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routineKey, layout.rooms, depth, loungeX, spine, totalW, smokeStop]);

  // The scene is built in grid units from the origin; centre it on the world.
  const offset = useMemo<[number, number, number]>(() => [-totalW / 2, 0, -depth / 2], [totalW, depth]);
  // From the front-right, looking at the two back walls — the cutaway angle.
  const cameraAt: [number, number, number] = [reach * 0.6, reach * 0.75, reach * 0.8];

  useEffect(() => () => void (document.body.style.cursor = ""), []);

  return (
    <div
      className={cn(
        "relative overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className ?? "h-[58svh] min-h-110",
      )}
      style={{ background: BG }}
      tabIndex={0}
      aria-label="The office. Q and E turn the view."
      onKeyDown={(event) => {
        const key = event.key.toLowerCase();
        if (key === "q") api.current?.turn(TURN);
        else if (key === "e") api.current?.turn(-TURN);
        else return;
        event.preventDefault();
      }}
    >
      <Canvas
        dpr={[1, 2]}
        shadows
        gl={{ antialias: true }}
        camera={{ position: cameraAt, fov: 38, near: 1, far: reach * 8 }}
        onPointerMissed={() => setHoveredId(null)}
      >
        <color attach="background" args={[BG]} />
        <ambientLight intensity={0.55} />
        <hemisphereLight args={["#ffffff", "#d9cbb3", 0.55]} />
        {/* The sun: one soft shadow-caster, its shadow box sized to the floor. */}
        <directionalLight
          position={[reach * 0.5, reach * 0.9, reach * 0.6]}
          intensity={1.6}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0006}
          shadow-normalBias={0.05}
          shadow-camera-left={-reach * 0.75}
          shadow-camera-right={reach * 0.75}
          shadow-camera-top={reach * 0.75}
          shadow-camera-bottom={-reach * 0.75}
          shadow-camera-near={1}
          shadow-camera-far={reach * 3}
        />

        <group position={offset}>
          <Building width={totalW} depth={depth} />
          {layout.rooms.map((room) => (
            <Room key={room.id} room={room} hoveredId={hoveredId} canOpen={canOpen} onHover={setHoveredId} onSelect={onSelect} />
          ))}
          <TownHall x={0} z={hallZ} w={hallW} count={everyone.length} live={activity === "allhands"} />
          <Lounge x={loungeX} width={LOUNGE_W} depth={depth} />

          {/* Ways in and out — doors set deeper than the outer wall so they show
              from inside and out — and the extinguishers by them. */}
          <GlassDoors x={entranceX} z={depth + 0.15} width={2.4} height={2.2} depth={0.36} label="ENTRANCE" />
          <Block position={[entranceX, 0.075, depth - 0.8]} size={[2.4, 0.02, 1.2]} color="#57534e" shadow={false} />

          {/* The lobby inside the entrance: carpets, security, turnstiles, visitors, CCTV. */}
          <Lobby x0={hallW + 0.4} x1={roomsW - 0.2} z0={layout.depth + 0.4} z1={depth - 0.1} entranceX={entranceX} />
          <FireExit x={totalW + 0.15} z={FIRE_EXIT_Z} />
          <SmokingArea x={totalW + 0.3} z={FIRE_EXIT_Z} />
          <ComfortRoom x={spine} count={routineUsers.length} />
          <Extinguisher x={entranceX - 1.7} z={depth - 0.5} />
          <Extinguisher x={totalW - 0.4} z={8.15} />
          <Extinguisher x={loungeX + 0.5} z={2.6} />

          <Cat stops={catStops} />

          {/* Everybody who is in — at their desks, walking, at lunch, or at the all-hands. */}
          {/* ⚠️ Somebody hidden is only ever drawn in a seat. With no seat — the
              room full, or this machine's clock not yet at the hour — they would
              be at a desk inside a closed room, their name through the roof. */}
          {everyone.map(({ room, desk }) =>
            // A seat beats the walk: a roamer who is timed in still goes to lunch and the all-hands.
            desk.person.roams && !away.has(desk.person.id) ? (
              <Roamer
                key={desk.person.id}
                person={desk.person}
                accent={DEPT[room.colorIndex % DEPT.length].sign}
                stops={isSmoker(desk.person) ? smokerStops : roamStops}
                smoker={isSmoker(desk.person)}
                hovered={hoveredId === desk.person.id}
                openable={canOpen(desk.person.id)}
                onHover={setHoveredId}
                onSelect={onSelect}
              />
            ) : desk.person.status === "working" && (!desk.person.hidden || away.has(desk.person.id)) ? (
              <Occupant
                key={desk.person.id}
                person={desk.person}
                accent={DEPT[room.colorIndex % DEPT.length].sign}
                chair={[desk.x + 1.1, desk.y + 1.6]}
                routine={routines.get(desk.person.id) ?? null}
                smoker={isSmoker(desk.person)}
                seat={away.get(desk.person.id) ?? null}
                presenting={desk.person.id === presenter}
                hovered={hoveredId === desk.person.id}
                openable={canOpen(desk.person.id)}
                onHover={setHoveredId}
                onSelect={onSelect}
              />
            ) : null,
          )}
        </group>

        <OrbitControls
          ref={controls}
          makeDefault
          enableDamping
          dampingFactor={0.12}
          maxPolarAngle={Math.PI / 2.15}
          /* Like a map or the Sims: drag moves across the floor, right-drag
             turns, the wheel zooms. One finger moves, two turn and zoom. */
          mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }}
          touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE }}
          screenSpacePanning={false}
          minDistance={4}
          maxDistance={reach * 2.2}
          target={[0, 0, 0]}
        />
        <CameraBridge apiRef={api} controlsRef={controls} bounds={{ x: totalW / 2, z: depth / 2 }} />
      </Canvas>

      <div className="absolute top-2 right-2 flex flex-col gap-1">
        <Button size="icon-sm" variant="outline" aria-label="Zoom in" onClick={() => api.current?.zoom(1.3)}>
          <Plus />
        </Button>
        <Button size="icon-sm" variant="outline" aria-label="Zoom out" onClick={() => api.current?.zoom(1 / 1.3)}>
          <Minus />
        </Button>
        <Button size="icon-sm" variant="outline" aria-label="Turn left" onClick={() => api.current?.turn(TURN)}>
          <RotateCcw />
        </Button>
        <Button size="icon-sm" variant="outline" aria-label="Turn right" onClick={() => api.current?.turn(-TURN)}>
          <RotateCw />
        </Button>
        <Button size="icon-sm" variant="outline" aria-label="Reset the view" onClick={() => api.current?.reset()}>
          <Maximize2 />
        </Button>
      </div>
      <p className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/80 px-1.5 py-0.5 text-2xs text-muted-foreground">
        Drag to move · right-drag, Shift-drag or Q / E to turn · scroll to zoom
      </p>
    </div>
  );
}
