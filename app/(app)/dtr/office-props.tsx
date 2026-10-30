"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { CanvasTexture, SRGBColorSpace, TextureLoader, type Mesh, type Texture } from "three";

import { Canteen } from "./office-amenities";
import { Block, Round } from "./office-block";

/**
 * The virtual office's furniture beyond the desks: windows, the small things on
 * a desk, the logo plaques, and the lounge — reception with the VizServe brand
 * wall, the clients wall, a coffee
 * bar, games, and a corner to sit in.
 */

const BRAND = "#4359a5";

/* -------------------------------------------------------------------------- */
/* Windows                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A window: frame, glass, and a cross of mullions. `along` is the axis the
 * window runs along — "x" on a wall that runs along X, "z" on one along Z.
 */
export function Window({ position, along }: { position: [number, number, number]; along: "x" | "z" }) {
  const [x, y, z] = position;
  const W = 1.7;
  const H = 0.62;
  const s = (a: number, b: number, c: number): [number, number, number] => (along === "x" ? [a, b, c] : [c, b, a]);
  return (
    <group position={[x, y, z]}>
      <Block position={[0, 0, 0]} size={s(W + 0.12, H + 0.12, 0.03)} color="#e5e7eb" shadow={false} />
      <Block position={[0, 0, 0]} size={s(W, H, 0.04)} color="#bfe2f1" emissive="#dbeafe" emissiveIntensity={0.25} shadow={false} />
      <Block position={[0, 0, 0]} size={s(0.05, H, 0.05)} color="#e5e7eb" shadow={false} />
      <Block position={[0, 0, 0]} size={s(W, 0.05, 0.05)} color="#e5e7eb" shadow={false} />
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Things on a desk                                                             */
/* -------------------------------------------------------------------------- */

export type DeskItemKind = "mug" | "plant" | "lamp" | "papers" | "photo" | "books";
export const DESK_ITEMS: DeskItemKind[] = ["mug", "plant", "lamp", "papers", "photo", "books"];

/** One small thing on the desk top (y 0.78). `on` lights a lamp. */
export function DeskItem({ kind, x, z, tint, on }: { kind: DeskItemKind; x: number; z: number; tint: string; on: boolean }) {
  const top = 0.78;
  switch (kind) {
    case "mug":
      return (
        <group position={[x, top, z]}>
          <Round position={[0, 0.07, 0]} radius={0.06} height={0.14} color={tint} segments={10} />
          <Block position={[0.075, 0.07, 0]} size={[0.03, 0.07, 0.02]} color={tint} shadow={false} />
        </group>
      );
    case "plant":
      return (
        <group position={[x, top, z]}>
          <Round position={[0, 0.06, 0]} radius={0.07} height={0.12} color="#b5672c" segments={10} />
          <Block position={[0, 0.2, 0]} size={[0.16, 0.16, 0.16]} color="#4caf50" />
          <Block position={[0.03, 0.31, -0.02]} size={[0.09, 0.09, 0.09]} color="#6cc46f" />
        </group>
      );
    case "lamp":
      return (
        <group position={[x, top, z]}>
          <Round position={[0, 0.015, 0]} radius={0.08} height={0.03} color="#374151" segments={10} />
          <Block position={[0, 0.17, 0]} size={[0.03, 0.3, 0.03]} color="#374151" shadow={false} />
          <Block
            position={[0.06, 0.33, 0]}
            size={[0.16, 0.07, 0.11]}
            color={on ? "#fde68a" : "#6b7280"}
            emissive={on ? "#fde68a" : undefined}
            emissiveIntensity={on ? 0.8 : 0}
          />
        </group>
      );
    case "papers":
      return (
        <group position={[x, top, z]}>
          {[0, 1, 2].map((i) => (
            <Block key={i} position={[i * 0.01, 0.01 + i * 0.012, i * 0.012]} size={[0.24, 0.01, 0.3]} color="#ffffff" shadow={false} />
          ))}
        </group>
      );
    case "photo":
      return (
        <group position={[x, top, z]}>
          <Block position={[0, 0.09, 0]} size={[0.16, 0.18, 0.02]} color="#6b4f34" rotation={[-0.25, 0, 0]} />
          <Block position={[0, 0.09, 0.012]} size={[0.12, 0.14, 0.005]} color={tint} rotation={[-0.25, 0, 0]} shadow={false} />
        </group>
      );
    case "books":
      return (
        <group position={[x, top, z]}>
          {["#dc2626", "#2563eb", "#16a34a"].map((c, i) => (
            <Block key={c} position={[0, 0.025 + i * 0.05, 0]} size={[0.22 - i * 0.02, 0.045, 0.3]} color={c} />
          ))}
        </group>
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Logos                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One load per URL, shared by every panel that shows it — ten rooms with the
 * same plaque upload one texture, not ten.
 */
const textures = new Map<string, Promise<Texture | null>>();
function loadTexture(url: string): Promise<Texture | null> {
  let pending = textures.get(url);
  if (!pending) {
    pending = new Promise((resolve) => {
      new TextureLoader().load(
        url,
        (loaded) => {
          loaded.colorSpace = SRGBColorSpace;
          loaded.anisotropy = 4;
          resolve(loaded);
        },
        undefined,
        () => resolve(null),
      );
    });
    textures.set(url, pending);
  }
  return pending;
}

/** An image texture once it has loaded; null before, or if the file is missing. */
export function useImage(url: string): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(null);
  useEffect(() => {
    let live = true;
    void loadTexture(url).then((loaded) => live && setTexture(loaded));
    return () => {
      live = false;
    };
  }, [url]);
  return texture;
}

/** Text drawn onto a texture — sharp at any zoom, no font download. */
export function useTextTexture(text: string, color: string, size = 110, width = 1600, height = 192) {
  return useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = color;
      ctx.font = `800 ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
      ctx.fillText(text, width / 2, height / 2);
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }, [text, color, size, width, height]);
}

/** A picture laid flat, fitted inside `w × h` without stretching. */
export function Picture({ texture, w, h }: { texture: Texture; w: number; h: number }) {
  const image = texture.image as { width?: number; height?: number } | undefined;
  const aspect = image?.width && image?.height ? image.width / image.height : w / h;
  const fw = Math.min(w, h * aspect);
  const fh = fw / aspect;
  return (
    <mesh>
      <planeGeometry args={[fw, fh]} />
      <meshBasicMaterial map={texture} transparent toneMapped={false} />
    </mesh>
  );
}

/**
 * A logo on the wall, with a line of text under it. `panel` sets it on a white
 * sign board — what a full-colour logo needs on the navy wall.
 */
function WallLogo({
  src,
  caption,
  position,
  w,
  h,
  panel = false,
}: {
  src: string;
  caption: string;
  position: [number, number, number];
  w: number;
  h: number;
  panel?: boolean;
}) {
  const image = useImage(src);
  const label = useTextTexture(caption, "#cbd5e1", 96);
  return (
    <group position={position}>
      {panel ? (
        <>
          <Block position={[0, 0, -0.04]} size={[w + 0.42, h + 0.32, 0.05]} color="#cbd5e1" />
          <Block position={[0, 0, -0.01]} size={[w + 0.3, h + 0.2, 0.03]} color="#ffffff" shadow={false} />
        </>
      ) : null}
      {image ? (
        <group position={[0, 0, 0.01]}>
          <Picture texture={image} w={w} h={h} />
        </group>
      ) : null}
      <group position={[0, -h / 2 - (panel ? 0.32 : 0.22), 0]}>
        <Picture texture={label} w={w} h={0.2} />
      </group>
    </group>
  );
}

/** A photo in a dark frame with a white mat, fitted without stretching. */
function FramedPhoto({ src, position, w, h }: { src: string; position: [number, number, number]; w: number; h: number }) {
  const image = useImage(src);
  return (
    <group position={position}>
      <Block position={[0, 0, 0]} size={[w + 0.14, h + 0.14, 0.05]} color="#111827" />
      <Block position={[0, 0, 0.03]} size={[w, h, 0.02]} color="#f8fafc" shadow={false} />
      {image ? (
        <group position={[0, 0, 0.045]}>
          <Picture texture={image} w={w - 0.16} h={h - 0.16} />
        </group>
      ) : null}
    </group>
  );
}

/**
 * A small framed plaque for a room wall — the VizServe mark, or the HFSE crest.
 * Positioned like the rest of the wall decor: X along the wall, on its face.
 */
export function Plaque({ src, x, y, z, size = 0.8 }: { src: string; x: number; y: number; z: number; size?: number }) {
  const image = useImage(src);
  return (
    <group position={[x, y, z]}>
      <Block position={[0, 0, 0]} size={[size + 0.12, size + 0.12, 0.03]} color="#cbd5e1" shadow={false} />
      <Block position={[0, 0, 0.02]} size={[size, size, 0.02]} color="#ffffff" shadow={false} />
      {image ? (
        <group position={[0, 0, 0.035]}>
          <Picture texture={image} w={size - 0.1} h={size - 0.1} />
        </group>
      ) : null}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Our clients                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * VizServe's clients, as vizserve.com lists them. The logos are copied into
 * `public/assets/clients/` (300×300 each), so the office does not depend on
 * the marketing site being up. Add a client: drop the file there and a line here.
 */
export const CLIENTS = [
  "hfse",
  "hfse-geg",
  "hfse-global-academy",
  "hfse-youngstarters",
  "vizschool",
  "mastereign",
  "bng",
  "spruson",
  "stagehaus",
  "hapi-space",
  "hapi-haus",
  "our-hapi-co",
] as const;

function ClientTile({ name, x, y }: { name: string; x: number; y: number }) {
  const image = useImage(`/assets/clients/${name}.png`);
  return (
    <group position={[x, y, 0]}>
      <Block position={[0, 0, 0]} size={[0.76, 0.76, 0.04]} color="#ffffff" shadow={false} />
      {image ? (
        <group position={[0, 0, 0.025]}>
          <Picture texture={image} w={0.7} h={0.7} />
        </group>
      ) : null}
    </group>
  );
}

/**
 * A freestanding wall of client logos, six across and two down, facing +Z
 * in its own frame — turn it into place.
 */
export function ClientWall({ position, rotation }: { position: [number, number, number]; rotation: [number, number, number] }) {
  const title = useTextTexture("OUR CLIENTS", "#ffffff", 120);
  const cols = 6;
  const rows = Math.ceil(CLIENTS.length / cols);
  const step = 0.85;
  const width = cols * step + 0.5;
  const height = rows * step + 0.9;

  return (
    <group position={position} rotation={rotation}>
      <Block position={[0, height / 2, -0.12]} size={[width, height, 0.2]} color="#1e2a4a" />
      <Block position={[0, height - 0.02, -0.1]} size={[width, 0.06, 0.24]} color={BRAND} />
      <group position={[0, height - 0.38, 0.0]}>
        <Picture texture={title} w={width - 0.4} h={0.32} />
      </group>
      {CLIENTS.map((name, i) => (
        <ClientTile
          key={name}
          name={name}
          x={(i % cols) * step - ((cols - 1) * step) / 2}
          y={height - 0.95 - Math.floor(i / cols) * step}
        />
      ))}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* The lounge                                                                   */
/* -------------------------------------------------------------------------- */

function Plant({ x, z, tall = false }: { x: number; z: number; tall?: boolean }) {
  return (
    <group position={[x, 0, z]}>
      <Round position={[0, 0.24, 0]} radius={0.26} height={0.48} color="#d6d3d1" segments={12} />
      <Block position={[0, 0.72, 0]} size={[0.6, 0.5, 0.6]} color="#3f9b54" />
      <Block position={[0.05, 1.1, -0.04]} size={[0.42, 0.4, 0.42]} color="#56b86b" />
      {tall ? <Block position={[-0.04, 1.45, 0.03]} size={[0.3, 0.35, 0.3]} color="#6cc46f" /> : null}
    </group>
  );
}

function Stool({ x, z }: { x: number; z: number }) {
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.35, 0]} size={[0.05, 0.7, 0.05]} color="#374151" />
      <Round position={[0, 0.72, 0]} radius={0.18} height={0.06} color={BRAND} segments={12} />
      <Round position={[0, 0.02, 0]} radius={0.16} height={0.03} color="#374151" segments={12} />
    </group>
  );
}

/** The vending machine's front, glowing, and a slow blink on its coin slot. */
function Vending({ x, z }: { x: number; z: number }) {
  const light = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (light.current) light.current.visible = Math.floor(clock.elapsedTime * 1.5) % 2 === 0;
  });
  const snacks = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];
  return (
    <group position={[x, 0, z]}>
      <Block position={[0, 0.95, 0]} size={[0.8, 1.9, 0.9]} color="#b91c1c" />
      <Block position={[-0.41, 1.1, 0]} size={[0.02, 1.3, 0.62]} color="#e0f2fe" emissive="#bae6fd" emissiveIntensity={0.5} shadow={false} />
      {snacks.flatMap((c, row) =>
        [0, 1, 2].map((col) => (
          <Block
            key={`${row}-${col}`}
            position={[-0.43, 0.6 + (row % 3) * 0.38 + (row > 2 ? 0.19 : 0) * 0, -0.2 + col * 0.2 + (row > 2 ? 0.0 : 0)]}
            size={[0.02, 0.12, 0.14]}
            color={snacks[(row + col) % snacks.length]}
            shadow={false}
          />
        )),
      )}
      <mesh ref={light} position={[-0.42, 0.4, 0.3]}>
        <boxGeometry args={[0.02, 0.06, 0.06]} />
        <meshStandardMaterial color="#22c55e" emissive="#22c55e" emissiveIntensity={1} />
      </mesh>
    </group>
  );
}

/**
 * Where the canteen sits in a lounge of `depth`: after the games, before the
 * sofa corner. Shared with the scene, which seats people there at lunch.
 */
export function canteenSpan(depth: number): { from: number; to: number } {
  return { from: 9.6, to: Math.max(11.2, depth - 2.4) - 1.7 };
}

/**
 * The lounge, `LOUNGE_W` wide, from `x`, the full `depth`:
 * reception and the brand walls at the back; the coffee bar along the right;
 * pool and ping-pong in the middle; a sofa corner and a meeting table at the front.
 */
export function Lounge({ x, width, depth }: { x: number; width: number; depth: number }) {
  const cx = x + width / 2;
  const right = x + width;

  return (
    <group>
      {/* The lounge floor: a lighter rug, so it reads as its own space. */}
      <Block position={[cx, 0.03, depth / 2]} size={[width - 0.5, 0.04, depth - 0.5]} color="#ece4d6" shadow={false} />

      {/* ---------------------------------------------------- reception -- */}
      {/* The brand wall: VizServe, and the team. */}
      <group position={[cx, 0, 0.45]}>
        <Block position={[0, 1.35, 0]} size={[width - 0.8, 2.7, 0.22]} color="#1e2a4a" />
        <Block position={[0, 2.66, 0.02]} size={[width - 0.8, 0.08, 0.24]} color={BRAND} />
        <WallLogo src="/assets/vizserve-logo-color.png" caption="VIZSERVE TEAM PORTAL" position={[-1.95, 1.72, 0.115]} w={1.55} h={1.55} panel />
        {/* The team, framed — the photo from vizserve.com's team page. */}
        <FramedPhoto src="/assets/vizserve-team.jpg" position={[1.55, 1.6, 0.115]} w={3.1} h={1.95} />
        {/* Spotlights over the logo. */}
        {[-1.95, 1.55].map((px) => (
          <Block key={px} position={[px, 2.45, 0.35]} size={[0.3, 0.06, 0.18]} color="#f8fafc" emissive="#fef9c3" emissiveIntensity={0.9} />
        ))}
      </group>

      {/* The reception desk, with a VizServe-blue band. */}
      <group position={[cx, 0, 2.3]}>
        <Block position={[0, 0.55, 0]} size={[3, 1.1, 0.6]} color="#f8fafc" />
        <Block position={[0, 0.55, 0.305]} size={[3, 0.18, 0.02]} color={BRAND} shadow={false} />
        <Block position={[0, 1.13, -0.05]} size={[3.2, 0.06, 0.75]} color="#e2e8f0" />
        <Block position={[-1.25, 0.55, -0.6]} size={[0.6, 1.1, 0.7]} color="#f8fafc" />
        <Block position={[0.5, 1.4, -0.15]} size={[0.6, 0.38, 0.04]} color="#1f2937" />
        <Block position={[0.5, 1.4, -0.125]} size={[0.54, 0.32, 0.01]} color="#7dd3fc" emissive="#7dd3fc" emissiveIntensity={0.5} shadow={false} />
        <Round position={[-0.6, 1.2, 0.1]} radius={0.06} height={0.08} color="#facc15" segments={10} />
      </group>
      <Plant x={x + 0.7} z={1.2} tall />
      <Plant x={right - 0.7} z={1.2} tall />

      {/* VizServe's clients, along the left edge, facing into the lounge. */}
      <ClientWall position={[x + 0.4, 0, 6]} rotation={[0, Math.PI / 2, 0]} />

      {/* ---------------------------------------------------- coffee bar -- */}
      <group position={[right - 0.55, 0, 4.6]}>
        <Block position={[0, 0.5, 0]} size={[0.7, 1, 2.6]} color="#6d4c2f" />
        <Block position={[0, 1.02, 0]} size={[0.8, 0.05, 2.7]} color="#e7e5e4" />
        {/* Espresso machine. */}
        <Block position={[0.05, 1.3, -0.8]} size={[0.5, 0.5, 0.45]} color="#9ca3af" />
        <Block position={[-0.2, 1.22, -0.8]} size={[0.06, 0.12, 0.2]} color="#111827" />
        {/* Cups. */}
        {[0, 1, 2, 3].map((i) => (
          <Round key={i} position={[-0.1, 1.11, -0.1 + i * 0.18]} radius={0.05} height={0.12} color={i % 2 ? "#ffffff" : BRAND} segments={10} />
        ))}
        <Block position={[-0.05, 1.08, 0.85]} size={[0.4, 0.06, 0.4]} color="#f5f5f4" />
      </group>
      <Stool x={right - 1.4} z={3.9} />
      <Stool x={right - 1.4} z={4.7} />
      <Stool x={right - 1.4} z={5.5} />
      <Vending x={right - 0.55} z={6.6} />
      {/* Water cooler. */}
      <group position={[right - 0.5, 0, 7.6]}>
        <Block position={[0, 0.5, 0]} size={[0.45, 1, 0.45]} color="#f1f5f9" />
        <Round position={[0, 1.25, 0]} radius={0.18} height={0.5} color="#93c5fd" segments={12} />
      </group>

      {/* ---------------------------------------------------- games -- */}
      <group position={[cx - 0.9, 0, 5]}>
        <Block position={[0, 0.8, 0]} size={[2.6, 0.08, 1.4]} color="#2e7d4f" />
        <Block position={[0, 0.72, 0]} size={[2.85, 0.14, 1.65]} color="#6d4c2f" />
        {[-1.2, 1.2].flatMap((lx) =>
          [-0.65, 0.65].map((lz) => <Block key={`${lx}${lz}`} position={[lx, 0.33, lz]} size={[0.16, 0.66, 0.16]} color="#5a3d25" />),
        )}
        {["#ef4444", "#facc15", "#3b82f6", "#ffffff", "#a855f7", "#111827", "#f97316"].map((c, i) => (
          <mesh key={c} position={[-0.5 + (i % 4) * 0.13, 0.885, -0.1 + Math.floor(i / 4) * 0.13]} castShadow>
            <sphereGeometry args={[0.055, 8, 6]} />
            <meshStandardMaterial color={c} flatShading />
          </mesh>
        ))}
        <Block position={[0.6, 0.86, 0.3]} size={[1.3, 0.025, 0.025]} color="#d6a76b" rotation={[0, 0.3, 0]} />
      </group>
      {depth > 10 ? (
        <group position={[cx - 0.9, 0, 8.2]}>
          <Block position={[0, 0.74, 0]} size={[2.8, 0.06, 1.5]} color="#1e5aa8" />
          <Block position={[0, 0.775, 0]} size={[2.8, 0.01, 0.03]} color="#ffffff" shadow={false} />
          <Block position={[0, 0.86, 0]} size={[0.03, 0.16, 1.6]} color="#f1f5f9" opacity={0.85} />
          <Block position={[-1, 0.36, 0]} size={[0.14, 0.72, 1.1]} color="#334155" />
          <Block position={[1, 0.36, 0]} size={[0.14, 0.72, 1.1]} color="#334155" />
          <Block position={[-0.9, 0.78, 0.3]} size={[0.16, 0.02, 0.2]} color="#dc2626" />
        </group>
      ) : null}

      {/* ---------------------------------------------------- the canteen -- */}
      {/* Everything between the games and the sofa corner. */}
      <Canteen x={x} width={width} {...canteenSpan(depth)} />

      {/* ---------------------------------------------------- the sofa corner -- */}
      <group position={[x, 0, Math.max(11.2, depth - 2.4)]}>
        <Block position={[2, 0.032, 0.2]} size={[3.4, 0.03, 2.6]} color="#c7d2fe" shadow={false} />
        {/* Sofa: seat, back, arms, cushions. */}
        <Block position={[0.85, 0.25, 0.2]} size={[0.9, 0.5, 2.4]} color="#64748b" />
        <Block position={[0.5, 0.65, 0.2]} size={[0.25, 0.6, 2.4]} color="#475569" />
        <Block position={[0.85, 0.42, -0.9]} size={[0.9, 0.3, 0.22]} color="#475569" />
        <Block position={[0.85, 0.42, 1.3]} size={[0.9, 0.3, 0.22]} color="#475569" />
        {[-0.4, 0.4].map((cz) => (
          <Block key={cz} position={[0.9, 0.56, 0.2 + cz * 1.2]} size={[0.6, 0.12, 0.9]} color="#94a3b8" />
        ))}
        <Block position={[0.68, 0.78, -0.2]} size={[0.15, 0.32, 0.32]} color="#f59e0b" rotation={[0, 0, 0.2]} />
        {/* Coffee table, and a TV facing the sofa. */}
        <Block position={[2.1, 0.32, 0.2]} size={[0.8, 0.06, 1.2]} color="#a16207" />
        <Block position={[2.1, 0.15, 0.2]} size={[0.7, 0.3, 1.1]} color="#78350f" />
        <Round position={[2.1, 0.4, 0.4]} radius={0.06} height={0.1} color="#ffffff" segments={10} />
        <Block position={[3.5, 0.3, 0.2]} size={[0.45, 0.6, 1.8]} color="#374151" />
        <Block position={[3.55, 1.15, 0.2]} size={[0.08, 0.9, 1.6]} color="#111827" />
        <Block position={[3.505, 1.15, 0.2]} size={[0.01, 0.8, 1.5]} color="#38bdf8" emissive="#38bdf8" emissiveIntensity={0.45} shadow={false} />
        {/* Floor lamp. */}
        <Round position={[0.6, 0.02, -1.3]} radius={0.16} height={0.04} color="#374151" segments={10} />
        <Block position={[0.6, 0.85, -1.3]} size={[0.04, 1.6, 0.04]} color="#374151" />
        <Round position={[0.6, 1.7, -1.3]} radius={0.2} height={0.25} color="#fef3c7" emissive="#fde68a" emissiveIntensity={0.6} segments={10} />
      </group>

      {/* Meeting table. */}
      <group position={[right - 1.7, 0, Math.max(11.2, depth - 2.4)]}>
        <Round position={[0, 0.74, 0]} radius={1} height={0.06} color="#f5f4f0" segments={20} />
        <Round position={[0, 0.37, 0]} radius={0.08} height={0.74} color="#9ca3af" segments={10} />
        {[0, 1, 2, 3, 4].map((i) => {
          const a = (i * Math.PI * 2) / 5;
          return (
            <group key={i} position={[Math.cos(a) * 1.35, 0, Math.sin(a) * 1.35]} rotation={[0, -a + Math.PI / 2, 0]}>
              <Block position={[0, 0.45, 0]} size={[0.5, 0.07, 0.5]} color="#3e4757" />
              <Block position={[0, 0.75, 0.24]} size={[0.5, 0.55, 0.06]} color="#3e4757" />
              <Block position={[0, 0.22, 0]} size={[0.06, 0.44, 0.06]} color="#1f2937" />
            </group>
          );
        })}
      </group>
      <Plant x={x + 0.6} z={depth - 0.6} />
    </group>
  );
}
