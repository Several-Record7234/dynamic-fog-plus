import { useEffect, useState } from "react";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import FormControlLabel from "@mui/material/FormControlLabel";
import Divider from "@mui/material/Divider";
import Alert from "@mui/material/Alert";
import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { getMetadata } from "../util/getMetadata";
import type { PersistenceSettings, PersistencePerf } from "../persistence/types";
import { DEFAULT_PERSISTENCE_SETTINGS, DEFAULT_PERSISTENCE_PERF } from "../persistence/types";

/** Computation time thresholds (ms) */
const WARN_TOTAL_MS = 16; // One frame at 60fps
const CRITICAL_TOTAL_MS = 50; // Noticeable stutter

/** Status messages for accumulator strategies */
const STATUS_MESSAGES: Record<PersistencePerf["status"], string | null> = {
  ok: null,
  simplified: "Auto-simplified to reduce vertex count",
  region_split: "New exploration stored as separate region (high vertex count)",
  rejected: "Vertex limit reached — exploration paused. Reset to continue.",
};

export function PersistenceControls() {
  const [settings, setSettings] = useState<PersistenceSettings>(
    DEFAULT_PERSISTENCE_SETTINGS
  );
  const [perf, setPerf] = useState<PersistencePerf>(DEFAULT_PERSISTENCE_PERF);
  const [role, setRole] = useState<"GM" | "PLAYER">("PLAYER");

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

  async function handleReset() {
    await OBR.scene.setMetadata({
      [getPluginId("persistence-reset")]: Date.now(),
    });
    setPerf(DEFAULT_PERSISTENCE_PERF);
  }

  if (role !== "GM") {
    return (
      <Stack px={2} py={1.5}>
        <Typography variant="body2" color="text.secondary">
          Persistence controls are only available to the GM.
        </Typography>
      </Stack>
    );
  }

  // Determine alert severity from both timing and accumulator status
  const statusMessage = STATUS_MESSAGES[perf.status];
  const isRejected = perf.status === "rejected";
  const timingWarn =
    perf.totalMs >= CRITICAL_TOTAL_MS
      ? "error"
      : perf.totalMs >= WARN_TOTAL_MS
        ? "warning"
        : null;

  const alertSeverity = isRejected
    ? "error" as const
    : perf.status === "region_split"
      ? "warning" as const
      : timingWarn;

  const alertMessage = isRejected
    ? statusMessage
    : perf.status === "region_split"
      ? statusMessage
      : timingWarn === "error"
        ? `Computation took ${perf.totalMs}ms — exceeds frame budget. Consider resetting.`
        : timingWarn === "warning"
          ? `Computation took ${perf.totalMs}ms — approaching frame budget.`
          : statusMessage;

  return (
    <Stack px={2} py={1} gap={1}>
      <Typography variant="subtitle2">Fog Persistence</Typography>
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
            {settings.enabled ? "Enabled" : "Disabled"}
          </Typography>
        }
      />

      {settings.enabled && perf.vertexCount > 0 && (
        <>
          <Divider />
          <Stack gap={0.25}>
            <Typography variant="caption" color="text.secondary">
              Vertices: {perf.vertexCount}
              {" | "}Walls: {perf.wallCount}
            </Typography>
            {perf.totalMs > 0 && (
              <Typography variant="caption" color="text.secondary">
                Last cycle: {perf.totalMs}ms
                {" ("}vis {perf.visMs}ms + union {perf.unionMs}ms{")"}
              </Typography>
            )}
          </Stack>

          {alertSeverity && alertMessage && (
            <Alert severity={alertSeverity} sx={{ py: 0, "& .MuiAlert-message": { py: 0.5 } }}>
              <Typography variant="caption">{alertMessage}</Typography>
            </Alert>
          )}
        </>
      )}

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
    </Stack>
  );
}
