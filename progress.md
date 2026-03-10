# Dynamic Fog Plus — Progress

## Current State (v0.0.0)

- Fork of official dynamic fog extension
- Inherited MUI/Emotion + CanvasKit codebase
- Persistent reveal feature added: CanvasKit path boolean ops, vertex budget management, GM-only writes
- Development state unclear — needs assessment before further work

## Feature Concept: Greyscale Memory Zone

**Intent**: Previously-visited areas (persistence reveal with no active light) appear greyscale, as if remembered rather than currently seen. Active light areas remain full colour. Unexplored areas remain hidden by fog.

**Architecture** (confirmed viable 2026-03-10):
1. Map-attached POST_PROCESS desaturation shader (low z-index, MAP parent) → greyscale everywhere
2. Per-token POST_PROCESS passthrough/identity shader (high z-index, CHARACTER parent) → full colour within light radius, feathered edge
3. FOG layer handles hide/reveal independently (unchanged)

**Key discovery**: POST_PROCESS shaders are winner-takes-all per pixel by z-index. `scene.eval()` samples the original pre-POST_PROCESS scene for all shaders. Verified by testing Aurora desaturation + neutral shader overlap. Logged to shared SKILL.md.

**Open questions**:
- [ ] How does dynamic-fog-plus create/manage the per-token POST_PROCESS attachments? (needs effect manager similar to Aurora's)
- [ ] Coordinate space transform for token attachment bounds
- [ ] Performance impact of N additional POST_PROCESS effects (one per light-bearing token)
- [ ] Does the passthrough shader need to exactly match the light's attenuation radius and falloff shape, or can it be a simple circle?
- [ ] Interaction with Aurora if both are active on the same map item

## Next Steps

- [ ] Assess overall project state and decide whether to continue development
- [ ] If continuing: greyscale memory zone is a candidate feature
