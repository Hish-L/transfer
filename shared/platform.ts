// Platform detection and camera capability probing.
//
// Policy: probe (probeCameraCapabilities) wherever the behavior is probeable;
// the UA sniffs exist only for quirks that are not — frame-rate negotiation
// semantics, refusing a live applyConstraints, install-flow UI.

const nav = typeof navigator === "undefined" ? undefined : navigator;

/** Every iOS browser is WebKit (Chrome-on-iOS included), so this really means
 *  "mobile WebKit" — which is the axis the camera quirks vary on. iPadOS
 *  reports itself as MacIntel; the touch-point count is what gives it away. */
export const isIOS: boolean =
  !!nav &&
  (/iPad|iPhone|iPod/.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && nav.maxTouchPoints > 1));

export const isAndroid: boolean = !!nav && /Android/.test(nav.userAgent);

// Chrome-on-Android extensions to the mediacapture spec that lib.dom doesn't
// type. iOS Safari exposes none of them, which is why every use sits behind
// a probe rather than a platform check.
type ExtendedCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  focusMode?: string[];
};
type ExtendedConstraintSet = MediaTrackConstraintSet & {
  torch?: boolean;
  focusMode?: string;
};

export interface CameraCapabilities {
  /** Reported but deliberately unused: the sender is an emissive screen, so a
   *  flashlight adds glare, never light the camera was missing. */
  torch: boolean;
  continuousFocus: boolean;
  /** Highest frame rate the current camera mode reports, when it reports one. */
  maxFrameRate?: number;
}

export function probeCameraCapabilities(track: MediaStreamTrack): CameraCapabilities {
  // getCapabilities itself is optional — Firefox shipped it years after the rest.
  const caps: ExtendedCapabilities = track.getCapabilities?.() ?? {};
  return {
    torch: caps.torch === true,
    continuousFocus: Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous"),
    maxFrameRate: caps.frameRate?.max,
  };
}

/** Best-effort advanced constraint; true when the camera took it. The spec
 *  says advanced sets never reject, but Chrome throws for torch anyway. */
export async function applyAdvancedConstraint(
  track: MediaStreamTrack,
  set: ExtendedConstraintSet,
): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [set] });
    return true;
  } catch {
    return false;
  }
}
