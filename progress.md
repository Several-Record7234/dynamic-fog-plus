# Dynamic Fog Plus — Progress

## Last Session: 2026-03-10

### Completed This Session
- PRIMARY/SECONDARY light type distinction implemented in `positionTracker.ts`
- SECONDARY lights persist their full illuminated area when a PC has LoS (any distance)
- `persistDistantLights` toggle added to PersistenceSettings + action popover UI (default: true)
- Removed `buildVisualBoundary()` stroke expansion (caused CanvasKit dash() errors)
- Fog item strokeWidth changed from 0 to 1 with strokeOpacity 0 (avoids OBR dash() bug)
- Persistence radius scaling: hard-edge 90%, soft-edge 80%, grid-boundary snapped
- Undo Reset bug fixed (lastDiscardTimestamp tracking)
- Vite manifest version sync plugin added
- Retrace brief written and compatibility analysis completed (`c:\Coding\Retrace\retrace-brief.md`)

### Untested (needs deployment verification)
- SECONDARY light full-pool persistence — the LoS path now extends to `dist + attenuationRadius + cachedDpi` and is passed to `computeSecondaryIntersection` instead of the PRIMARY's small persistence path
- `persistDistantLights` toggle in the action popover (when false, SECONDARY lights are entirely ignored for persistence)

### Overall State
- Fork of official dynamic fog extension with persistent reveal feature
- Inherited MUI/Emotion + CanvasKit codebase
- CanvasKit path boolean ops, vertex budget management, GM-only writes

## Feature Concept: Greyscale Memory Zone

**Intent**: Previously-visited areas (persistence reveal with no active light) appear greyscale, as if remembered rather than currently seen. Active light areas remain full colour. Unexplored areas remain hidden by fog.

**Architecture** (confirmed viable 2026-03-10):
1. Map-attached POST_PROCESS desaturation shader (low z-index, MAP parent) → greyscale everywhere
2. Per-token POST_PROCESS passthrough/identity shader (high z-index, CHARACTER parent) → full colour within light radius, feathered edge
3. FOG layer handles hide/reveal independently (unchanged)

**Key discovery**: POST_PROCESS shaders are winner-takes-all per pixel by z-index. `scene.eval()` samples the original pre-POST_PROCESS scene for all shaders. Verified by testing Aurora desaturation + neutral shader overlap. Logged to shared SKILL.md.

**Open questions**:
- [ ] How does dynamic-fog-plus create/manage the per-token POST_PROCESS attachments?
- [ ] Coordinate space transform for token attachment bounds
- [ ] Performance impact of N additional POST_PROCESS effects
- [ ] Does the passthrough shader need to exactly match the light's attenuation radius and falloff shape?
- [ ] Interaction with Aurora if both are active on the same map item

## Next Steps
- [ ] Deploy and test SECONDARY light persistence at distance with toggle
- [ ] Consider building Retrace (fog eraser) tool into the extension
- [ ] Consider per-player vision (local fog cutouts approach)
- [ ] Consider Web Worker parallelisation for multi-token scenarios
- [ ] Greyscale memory zone is a candidate feature
