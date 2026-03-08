import { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
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
  const [confirmOpen, setConfirmOpen] = useState(false);

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

  async function handleResetConfirmed() {
    setConfirmOpen(false);
    await OBR.scene.setMetadata({
      [getPluginId("persistence-reset")]: Date.now(),
    });
    setPerf(DEFAULT_PERSISTENCE_PERF);
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
        label={
          <Typography variant="body2">
            Fog persistence{" "}
            <Typography component="span" variant="body2" color="text.secondary">
              {settings.enabled ? "(on)" : "(off)"}
            </Typography>
          </Typography>
        }
      />

      {settings.enabled && (
        <>
          {/* Persistence opacity dropdown */}
          <Stack direction="row" alignItems="center" gap={1}>
            <Typography variant="body2" sx={{ whiteSpace: "nowrap" }}>
              Persistence opacity
            </Typography>
            <Select
              size="small"
              value={settings.revealOpacity}
              onChange={(e) => handleOpacityChange(e.target.value as number)}
              sx={{ minWidth: 80 }}
            >
              {OPACITY_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </Select>
          </Stack>

          {/* Reset button */}
          <Button
            size="small"
            variant="outlined"
            color="error"
            onClick={() => setConfirmOpen(true)}
            disabled={perf.vertexCount === 0}
            fullWidth
          >
            Reset Explored Areas
          </Button>

          {/* Stats row */}
          {perf.vertexCount > 0 && (
            <Stack direction="row" alignItems="center" gap={0.5}>
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
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
                  </>
                )}
              </Typography>
              {timingColor && <WarningIcon color={timingColor} />}
            </Stack>
          )}
        </>
      )}

      {/* Reset confirmation dialog */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Reset Explored Areas?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will permanently delete all accumulated fog persistence data
            for this scene. This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button onClick={handleResetConfirmed} color="error" autoFocus>
            Reset
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
