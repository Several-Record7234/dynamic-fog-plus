import { Item } from "@owlbear-rodeo/sdk";
import { LightConfig } from "../types/LightConfig";
import { getMetadata } from "./getMetadata";

/** New DFP namespace — used for all new writes */
export const DFP_LIGHT_KEY = "rodeo.owlbear.dynamic-fog-plus/light";

/** Legacy DFP namespace — read-only backwards compatibility */
export const LEGACY_LIGHT_KEY = "rodeo.owlbear.dynamic-fog/light";

/** All light metadata keys, checked in priority order */
export const LIGHT_KEYS = [
  DFP_LIGHT_KEY,
  LEGACY_LIGHT_KEY,
] as const;

/** Returns true if the item has any recognised light config */
export function hasLightConfig(item: Item): boolean {
  return LIGHT_KEYS.some((key) => key in item.metadata);
}

/** Returns the metadata key that holds the light config, or null */
export function getLightKey(item: Item): string | null {
  for (const key of LIGHT_KEYS) {
    if (key in item.metadata) return key;
  }
  return null;
}

/** Reads the light config from the highest-priority key present */
export function readLightConfig(item: Item): LightConfig {
  for (const key of LIGHT_KEYS) {
    if (key in item.metadata) {
      return getMetadata<LightConfig>(item.metadata, key, {});
    }
  }
  return {};
}
