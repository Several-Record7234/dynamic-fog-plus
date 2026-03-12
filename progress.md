# Dynamic Fog Plus — Progress

## Last Session: 2026-03-12

### Completed This Session
- **OBR 500-command ceiling discovered and fixed**: OBR silently rejects Path item updates when total command count exceeds ~500. Previous thresholds (1500/3000/8000) were catastrophically wrong.
- **Curve-preserving simplification**: `simplifyAccumulated()` now only applies Douglas-Peucker to runs of consecutive LINE commands, passing native curves (CONIC, CUBIC, QUAD) through unchanged. ~3.5x command reduction (101→29 for overlapping circles, 4 for full circle, 2 per doorway arc).
- **Command-based budget**: Renamed `getTotalVertexCount()` → `getTotalCommandCount()`, counts ALL commands including CLOSE. New thresholds: soft=200, hard=350, reject=450.
- **Removed unnecessary concurrency guard**: `computeInFlight` flag in positionTracker was blocking async I/O for ~150ms, causing patchy updates. Accumulator mutations are synchronous and safe without it.
- **Web Worker tuning**: Raised `MIN_SHAPES_FOR_WORKERS` from 4 to 12, added PathOp error checking in workers.
- **Action UI**: Label changed from "Vertices:" to "Cmds:" to reflect command count metric.
- Deployed and verified: persistence updates are snappy and responsive.

### Known Issues
- Single `[Worker] PathOp.Union failed for frustum` warning appeared once — not yet investigated, may be a rare edge case in shadow frustum computation.

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
- [ ] Investigate worker PathOp.Union frustum failure (single occurrence, needs reproduction)
- [ ] Performance benchmark on larger scenes (15-wall scene: ~45ms avg, no serial baseline)
- [ ] Consider building Retrace (fog eraser) tool into the extension
- [ ] Consider per-player vision (local fog cutouts approach)
- [ ] Greyscale memory zone is a candidate feature
