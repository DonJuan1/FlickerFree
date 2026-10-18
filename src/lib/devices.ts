// Which back camera to open. Chrome on Android labels cameras "camera2 <id>, facing
// back|front"; Android's camera id 0 is the main back camera, higher ids are the extra
// lenses (ultra-wide, tele), one of which Chrome may open for facingMode 'environment'.

export interface CameraDevice {
  deviceId: string;
  label: string;
  /** facingMode from InputDeviceInfo.getCapabilities(), where the browser provides it. */
  facing?: string[];
}

/** Android camera id from a Chrome label: "camera2 2, facing back" -> 2. */
export function cameraId(label: string): number | undefined {
  const m = /\bcamera2? (\d+)\b/i.exec(label);
  return m ? Number(m[1]) : undefined;
}

export function isBackCamera(d: CameraDevice): boolean {
  if (d.facing?.length) return d.facing.includes('environment');
  return /\b(back|rear|environment)\b/i.test(d.label);
}

/** Back cameras, main camera first: lowest Android id, else the listed order. */
export function backCameras(devices: CameraDevice[]): CameraDevice[] {
  return devices
    .filter(isBackCamera)
    .map((d, i) => ({ d, i, id: cameraId(d.label) ?? Infinity }))
    .sort((a, b) => a.id - b.id || a.i - b.i)
    .map((x) => x.d);
}

/** The camera to open: the remembered one if it is still there, else the main back camera. */
export function pickCamera(devices: CameraDevice[], preferred?: string | null): CameraDevice | undefined {
  const back = backCameras(devices);
  return back.find((d) => d.deviceId === preferred) ?? back[0];
}
