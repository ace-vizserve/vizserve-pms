"use client";

import { useMemo } from "react";
import { Billboard } from "@react-three/drei";
import { CanvasTexture, SRGBColorSpace } from "three";

/**
 * A room sign — a coloured board, the name in bold, a smaller line under it —
 * drawn INTO the scene rather than laid over it.
 *
 * ⚠️ WHY NOT `<Html>`, which the signs used to be. An overlay label is a DOM
 * element positioned over the canvas each frame, and one of them — always the
 * room in the far back corner — kept going missing while its neighbours drew.
 * A billboard is part of the scene: it cannot be lost, it always faces the
 * camera, and with `depthTest` off it still reads over the walls the way the
 * overlay did. The names over people stay `<Html>`; they move, and they work.
 */
export function Sign({
  position,
  title,
  subtitle,
  color,
  height = 0.55,
}: {
  position: [number, number, number];
  title: string;
  subtitle: string;
  color: string;
  /** World units, top to bottom. The width follows the text. */
  height?: number;
}) {
  const { texture, aspect } = useMemo(() => {
    const scale = 4;
    const titleSize = 13 * scale;
    const subSize = 9 * scale;
    const padX = 9 * scale;
    const padY = 6 * scale;
    const gap = 3 * scale;

    const measure = document.createElement("canvas").getContext("2d");
    const font = (size: number, weight: number) => `${weight} ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
    let width = 0;
    if (measure) {
      measure.font = font(titleSize, 800);
      width = measure.measureText(title).width;
      measure.font = font(subSize, 600);
      width = Math.max(width, measure.measureText(subtitle).width);
    }
    const w = Math.ceil(width + padX * 2);
    const h = Math.ceil(padY * 2 + titleSize + gap + subSize);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const r = 5 * scale;
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(w, 0, w, h, r);
      ctx.arcTo(w, h, 0, h, r);
      ctx.arcTo(0, h, 0, 0, r);
      ctx.arcTo(0, 0, w, 0, r);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = scale;
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.stroke();

      ctx.textBaseline = "top";
      ctx.fillStyle = "#ffffff";
      ctx.font = font(titleSize, 800);
      ctx.fillText(title, padX, padY);
      ctx.globalAlpha = 0.85;
      ctx.font = font(subSize, 600);
      ctx.fillText(subtitle, padX, padY + titleSize + gap);
    }
    const map = new CanvasTexture(canvas);
    map.colorSpace = SRGBColorSpace;
    map.anisotropy = 4;
    return { texture: map, aspect: w / h };
  }, [title, subtitle, color]);

  return (
    <Billboard position={position}>
      <mesh renderOrder={10}>
        <planeGeometry args={[height * aspect, height]} />
        <meshBasicMaterial map={texture} transparent toneMapped={false} depthTest={false} depthWrite={false} />
      </mesh>
    </Billboard>
  );
}

/**
 * A person's name chip — white, rounded, their first name — drawn in the scene
 * like `Sign`, for the same reason: an overlay label in the far back corner of
 * the floor kept failing to draw (it took Alicia's, the first desk). `dim` for
 * an empty desk.
 */
export function NameTag({
  position,
  name,
  dim = false,
  height = 0.3,
}: {
  position: [number, number, number];
  name: string;
  dim?: boolean;
  height?: number;
}) {
  const first = name.trim().split(/\s+/)[0] ?? name;
  const { texture, aspect } = useMemo(() => {
    const scale = 4;
    const size = 11 * scale;
    const padX = 6 * scale;
    const padY = 3.5 * scale;
    const font = `600 ${size}px system-ui, "Segoe UI", Arial, sans-serif`;
    const measure = document.createElement("canvas").getContext("2d");
    let width = 0;
    if (measure) {
      measure.font = font;
      width = measure.measureText(first).width;
    }
    const w = Math.ceil(width + padX * 2);
    const h = Math.ceil(size + padY * 2);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const r = 4 * scale;
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(w, 0, w, h, r);
      ctx.arcTo(w, h, 0, h, r);
      ctx.arcTo(0, h, 0, 0, r);
      ctx.arcTo(0, 0, w, 0, r);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.fill();
      ctx.fillStyle = dim ? "#8a7b6a" : "#2b2118";
      ctx.font = font;
      ctx.textBaseline = "middle";
      ctx.fillText(first, padX, h / 2 + scale * 0.5);
    }
    const map = new CanvasTexture(canvas);
    map.colorSpace = SRGBColorSpace;
    map.anisotropy = 4;
    return { texture: map, aspect: w / h };
  }, [first, dim]);

  return (
    <Billboard position={position}>
      <mesh renderOrder={9}>
        <planeGeometry args={[height * aspect, height]} />
        <meshBasicMaterial map={texture} transparent toneMapped={false} depthTest={false} depthWrite={false} />
      </mesh>
    </Billboard>
  );
}
