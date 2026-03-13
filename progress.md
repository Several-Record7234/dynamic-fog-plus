# Dynamic Fog Plus — Progress

## Last Session: 2026-03-13

### Completed This Session
- **Flicker interop reversed**: Removed DFP reading Flicker's `com.flicker/fog-light` key — Flicker now reads DFP's metadata keys directly instead
- **Namespace migration**: New DFP lights write to `rodeo.owlbear.dynamic-fog-plus/light`; reads check new key + legacy `rodeo.owlbear.dynamic-fog/light`
- **Light key helpers**: `src/util/lightKeys.ts` — `hasLightConfig`, `readLightConfig`, `getLightKey` centralise multi-key detection
- **Context menu filter fix**: OBR's `some` filter alone with `!=` operator silently fails — replaced with multiple icon entries using `every` (recorded in shared SKILL.md)
- **Fill rule loop-closure fix**: Persistence fog item `evenodd` → `nonzero` — fixes gaps where corridors loop back to form islands
- **EvenOdd normalization for fog shapes**: All fog paths set to `EvenOdd` before path ops, immune to CW/CCW drawing direction
- **Persistence toggle preserves shape**: Flips fog item `visible` (cut/uncut) instead of deleting — survives reload
- **Initial position persistence**: Settings load triggers initial item scan

### Known Issues
- Recurring frustum PathOp failures (union and difference) for certain fog shapes — harmless due to backup/restore, but shadow may be missing for affected shapes at some token positions

### Previous Session: 2026-03-12
- **OBR 500-command ceiling discovered and fixed**: OBR silently rejects Path item updates when total command count exceeds ~500. Previous thresholds (1500/3000/8000) were catastrophically wrong.
- **Curve-preserving simplification**: `simplifyAccumulated()` now only applies Douglas-Peucker to runs of consecutive LINE commands, passing native curves (CONIC, CUBIC, QUAD) through unchanged. ~3.5x command reduction (101→29 for overlapping circles, 4 for full circle, 2 per doorway arc).
- **Command-based budget**: Renamed `getTotalVertexCount()` → `getTotalCommandCount()`, counts ALL commands including CLOSE. New thresholds: soft=200, hard=350, reject=450.
- **Removed unnecessary concurrency guard**: `computeInFlight` flag in positionTracker was blocking async I/O for ~150ms, causing patchy updates. Accumulator mutations are synchronous and safe without it.
- **Web Worker tuning**: Raised `MIN_SHAPES_FOR_WORKERS` from 4 to 12, added PathOp error checking in workers.
- **Action UI**: Label changed from "Vertices:" to "Cmds:" to reflect command count metric.
- Deployed and verified: persistence updates are snappy and responsive.
- **PathOp failure recovery**: All `path.op()` calls backup before attempting, restore on failure. Prevents corrupt WASM state from cascading.
- **Persistence toggle fixes cut state**: Flips fog item `visible` property instead of delete/recreate. Survives reload naturally.
- **Fill rule fix (evenodd→nonzero)**: Persistence fog item uses `nonzero` fill rule to match CanvasKit union output. Fixes loop junction gaps.
- **EvenOdd normalization for fog shapes**: All fog paths set to `EvenOdd` fill type before path ops, making computation immune to CW/CCW drawing direction.
- **Initial position persistence**: Settings load now triggers initial item scan so tokens get their starting position persisted without needing to move first.
- Full complex map explored: 304 commands, <50ms processing, 15 fog shapes.

### Previous Session: 2026-03-10
- PRIMARY/SECONDARY light type distinction implemented
- SECONDARY lights persist full illuminated area when PC has LoS
- `persistDistantLights` toggle added (default: true)
- Removed `buildVisualBoundary()` stroke expansion
- Fog item strokeWidth:1/strokeOpacity:0 workaround
- Persistence radius scaling: hard-edge 90%, soft-edge 80%, grid-snapped
- Undo Reset bug fixed, Vite manifest version sync plugin added

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
- [ ] Investigate recurring worker PathOp frustum failures (harmless but could indicate edge-case geometry)
- [ ] Performance benchmark on larger scenes (15-wall scene: ~45ms avg, no serial baseline)
- [ ] Consider building Retrace (fog eraser) tool into the extension
- [ ] Consider per-player vision (local fog cutouts approach)
- [ ] Greyscale memory zone is a candidate feature
