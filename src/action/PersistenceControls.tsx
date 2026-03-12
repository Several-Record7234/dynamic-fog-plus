import { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import FormControlLabel from "@mui/material/FormControlLabel";
import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { getMetadata } from "../util/getMetadata";
import type { PersistenceSettings, PersistencePerf } from "../persistence/types";
import { DEFAULT_PERSISTENCE_SETTINGS, DEFAULT_PERSISTENCE_PERF } from "../persistence/types";

/** Computation time thresholds (ms) */
const WARN_TOTAL_MS = 16;
const CRITICAL_TOTAL_MS = 50;

/** Opacity dropdown options: 10% to 100% in 5% steps */
const OPACITY_OPTIONS = Array.from({ length: 19 }, (_, i) => {
  const value = (i + 2) * 0.05; // 0.10 to 1.00
  return { value, label: `${Math.round(value * 100)}%` };
});

/** How long the "Undo Reset" button stays available (seconds) */
const UNDO_WINDOW_SECONDS = 15;

/** Easter egg: number of clicks within the time window to toggle debug */
const DEBUG_CLICK_COUNT = 5;
const DEBUG_CLICK_WINDOW_MS = 2000;

/** Warning triangle SVG icon */
function WarningIcon({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"
        fill={color}
      />
    </svg>
  );
}

export function PersistenceControls() {
  const [settings, setSettings] = useState<PersistenceSettings>(
    DEFAULT_PERSISTENCE_SETTINGS
  );
  const [perf, setPerf] = useState<PersistencePerf>(DEFAULT_PERSISTENCE_PERF);
  const [role, setRole] = useState<"GM" | "PLAYER">("PLAYER");
  const [debugVis, setDebugVis] = useState(false);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
  const undoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-resize popover to fit content
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      OBR.action.setHeight(el.scrollHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Easter egg: track title clicks for debug toggle
  const clickTimesRef = useRef<number[]>([]);

  useEffect(() => {
    let mounted = true;

    async function init() {
      const playerRole = await OBR.player.getRole();
      if (mounted) setRole(playerRole);

      const metadata = await OBR.scene.getMetadata();
      if (mounted) {
        setSettings(
          getMetadata<PersistenceSettings>(
            metadata,
            getPluginId("persistence-settings"),
            DEFAULT_PERSISTENCE_SETTINGS
          )
        );
        setPerf(
          getMetadata<PersistencePerf>(
            metadata,
            getPluginId("persistence-perf"),
            DEFAULT_PERSISTENCE_PERF
          )
        );
        setDebugVis(
          getMetadata<boolean>(
            metadata,
            getPluginId("persistence-debug"),
            false
          )
        );
      }
    }

    init();

    const unsubscribe = OBR.scene.onMetadataChange((metadata) => {
      if (!mounted) return;
      setSettings(
        getMetadata<PersistenceSettings>(
          metadata,
          getPluginId("persistence-settings"),
          DEFAULT_PERSISTENCE_SETTINGS
        )
      );
      setPerf(
        getMetadata<PersistencePerf>(
          metadata,
          getPluginId("persistence-perf"),
          DEFAULT_PERSISTENCE_PERF
        )
      );
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  async function handleToggle(enabled: boolean) {
    const newSettings = { ...settings, enabled };
    setSettings(newSettings);
    await OBR.scene.setMetadata({
      [getPluginId("persistence-settings")]: newSettings,
    });
  }

  async function handleOpacityChange(value: number) {
    const newSettings = { ...settings, revealOpacity: value };
    setSettings(newSettings);
    await OBR.scene.setMetadata({
      [getPluginId("persistence-settings")]: newSettings,
    });
  }

  async function handleDistantLightsToggle(checked: boolean) {
    const newSettings = { ...settings, persistDistantLights: checked };
    setSettings(newSettings);
    await OBR.scene.setMetadata({
      [getPluginId("persistence-settings")]: newSettings,
    });
  }

  function clearUndoTimer() {
    if (undoTimerRef.current) {
      clearInterval(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }

  // Clean up timer on unmount
  useEffect(() => clearUndoTimer, []);

  async function handleReset() {
    await OBR.scene.setMetadata({
      [getPluginId("persistence-reset")]: Date.now(),
    });
    setPerf(DEFAULT_PERSISTENCE_PERF);

    // Start undo countdown
    setUndoAvailable(true);
    setUndoSecondsLeft(UNDO_WINDOW_SECONDS);
    clearUndoTimer();
    const deadline = Date.now() + UNDO_WINDOW_SECONDS * 1000;
    undoTimerRef.current = setInterval(() => {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      if (remaining <= 0) {
        clearUndoTimer();
        setUndoAvailable(false);
        setUndoSecondsLeft(0);
        // Signal background to discard the snapshot
        OBR.scene.setMetadata({
          [getPluginId("persistence-discard-undo")]: Date.now(),
        });
      } else {
        setUndoSecondsLeft(remaining);
      }
    }, 1000);
  }

  async function handleUndoReset() {
    clearUndoTimer();
    setUndoAvailable(false);
    setUndoSecondsLeft(0);
    await OBR.scene.setMetadata({
      [getPluginId("persistence-undo-reset")]: Date.now(),
    });
  }

  const handleTitleClick = useCallback(() => {
    const now = Date.now();
    const times = clickTimesRef.current;
    times.push(now);
    // Keep only clicks within the time window
    while (times.length > 0 && now - times[0] > DEBUG_CLICK_WINDOW_MS) {
      times.shift();
    }
    if (times.length >= DEBUG_CLICK_COUNT) {
      times.length = 0;
      const newDebug = !debugVis;
      setDebugVis(newDebug);
      OBR.scene.setMetadata({
        [getPluginId("persistence-debug")]: newDebug,
      });
    }
  }, [debugVis]);

  if (role !== "GM") {
    return (
      <Stack ref={contentRef} px={2} py={1.5}>
        <Typography variant="body2" color="text.secondary">
          Persistence controls are only available to the GM.
        </Typography>
      </Stack>
    );
  }

  // Timing indicator
  const timingColor =
    perf.totalMs >= CRITICAL_TOTAL_MS
      ? "#f44336" // red
      : perf.totalMs >= WARN_TOTAL_MS
        ? "#ff9800" // amber
        : undefined;

  return (
    <Stack ref={contentRef} px={2} py={1} gap={1}>
      {/* Header */}
      <Typography
        variant="subtitle2"
        onClick={handleTitleClick}
        sx={{ cursor: "default", userSelect: "none" }}
      >
        Dynamic Fog Plus
        {debugVis && (
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
            Click here 5x to cancel debug
          </Typography>
        )}
      </Typography>

      {/* Fog persistence toggle */}
      <FormControlLabel
        control={
          <Switch
            checked={settings.enabled}
            onChange={(_, checked) => handleToggle(checked)}
            size="small"
          />
        }
        label={<Typography variant="body2">Fog persistence</Typography>}
        labelPlacement="start"
        sx={{ mx: 0, justifyContent: "space-between", alignItems: "center" }}
      />

      {settings.enabled && (
        <>
          {/* Distant environmental lights toggle */}
          <FormControlLabel
            control={
              <Switch
                checked={settings.persistDistantLights}
                onChange={(_, checked) => handleDistantLightsToggle(checked)}
                size="small"
              />
            }
            label={<Typography variant="body2">Persist distant lights</Typography>}
            labelPlacement="start"
            sx={{ mx: 0, justifyContent: "space-between", alignItems: "center" }}
          />

          {/* Persistence opacity dropdown */}
          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
            <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
              Persistence opacity
            </Typography>
            <Select
              size="small"
              value={settings.revealOpacity}
              onChange={(e) => handleOpacityChange(e.target.value as number)}
              sx={{ minWidth: 72, "& .MuiSelect-select": { py: "4px" } }}
            >
              {OPACITY_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </Select>
          </Stack>

          {/* Reset / Undo button */}
          {undoAvailable ? (
            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={handleUndoReset}
              fullWidth
            >
              Undo Reset ({undoSecondsLeft}s)
            </Button>
          ) : (
            <Button
              size="small"
              variant="outlined"
              color="error"
              onClick={handleReset}
              disabled={perf.vertexCount === 0}
              fullWidth
            >
              Reset Explored Areas
            </Button>
          )}

          {/* Stats row */}
          {perf.vertexCount > 0 && (
            <Stack direction="row" alignItems="center" justifyContent="center" gap={0.5}>
              <Typography variant="caption" color="text.secondary">
                Vertices: {perf.vertexCount}
                {" | "}Walls: {perf.wallCount}
                {perf.totalMs > 0 && (
                  <>
                    {" | "}
                    <Box
                      component="span"
                      sx={timingColor ? { color: timingColor, fontWeight: 600 } : undefined}
                    >
                      {perf.totalMs}ms
                    </Box>
                    {perf.parallel && (
                      <Box
                        component="span"
                        sx={{ color: "#4caf50", fontWeight: 600, ml: "2px" }}
                        title="Parallel workers active"
                      >
                        W
                      </Box>
                    )}
                  </>
                )}
              </Typography>
              {timingColor && <WarningIcon color={timingColor} />}
            </Stack>
          )}
        </>
      )}

    </Stack>
  );
}
