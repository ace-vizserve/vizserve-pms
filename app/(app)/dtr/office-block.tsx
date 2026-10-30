"use client";

/**
 * The brick every piece of the virtual office is built from: a flat-shaded box
 * that casts and receives shadows. Shared by the scene, the walls and the props
 * so they all light the same way.
 */
export function Block({
  position,
  size,
  color,
  emissive,
  emissiveIntensity = 0,
  opacity,
  rotation,
  shadow = true,
}: {
  position: [number, number, number];
  size: [number, number, number];
  color: string;
  emissive?: string;
  emissiveIntensity?: number;
  opacity?: number;
  rotation?: [number, number, number];
  /** Off for things too thin or too many to be worth a shadow. */
  shadow?: boolean;
}) {
  return (
    <mesh position={position} rotation={rotation} castShadow={shadow} receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        flatShading
        roughness={0.85}
        emissive={emissive ?? "#000000"}
        emissiveIntensity={emissiveIntensity}
        transparent={opacity !== undefined}
        opacity={opacity ?? 1}
      />
    </mesh>
  );
}

/** A cylinder, for round things — tables, mugs, pots, the water cooler. */
export function Round({
  position,
  radius,
  height,
  color,
  emissive,
  emissiveIntensity = 0,
  segments = 16,
}: {
  position: [number, number, number];
  radius: number;
  height: number;
  color: string;
  emissive?: string;
  emissiveIntensity?: number;
  segments?: number;
}) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <cylinderGeometry args={[radius, radius, height, segments]} />
      <meshStandardMaterial
        color={color}
        flatShading
        roughness={0.8}
        emissive={emissive ?? "#000000"}
        emissiveIntensity={emissiveIntensity}
      />
    </mesh>
  );
}
