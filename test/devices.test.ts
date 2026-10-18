import { describe, expect, it } from 'vitest';
import { backCameras, cameraId, pickCamera, type CameraDevice } from '../src/lib/devices';

const list = (...labels: string[]): CameraDevice[] => labels.map((label, i) => ({ deviceId: `id${i}`, label }));

describe('pickCamera', () => {
  it('reads the Android camera id from Chrome labels', () => {
    expect(cameraId('camera2 2, facing back')).toBe(2);
    expect(cameraId('camera 0, facing back')).toBe(0);
    expect(cameraId('Back Camera')).toBeUndefined();
  });

  it('picks camera2 0 over the extra lenses, whatever the listed order', () => {
    const d = list('camera2 2, facing back', 'camera2 1, facing front', 'camera2 0, facing back', 'camera2 3, facing back');
    expect(pickCamera(d)?.label).toBe('camera2 0, facing back');
    expect(backCameras(d).map((c) => c.label)).toEqual(['camera2 0, facing back', 'camera2 2, facing back', 'camera2 3, facing back']);
  });

  it('takes the lowest back id when camera2 0 is not listed', () => {
    expect(pickCamera(list('camera2 1, facing front', 'camera2 4, facing back', 'camera2 2, facing back'))?.label).toBe('camera2 2, facing back');
  });

  it('keeps the listed order without Android ids', () => {
    expect(pickCamera(list('Front Camera', 'Back Camera', 'Back Ultra Wide Camera'))?.label).toBe('Back Camera');
  });

  it('prefers facingMode capabilities over the label', () => {
    const d: CameraDevice[] = [
      { deviceId: 'a', label: 'camera2 0', facing: ['user'] },
      { deviceId: 'b', label: 'camera2 5', facing: ['environment'] },
    ];
    expect(pickCamera(d)?.deviceId).toBe('b');
  });

  it('uses the remembered camera while it is there', () => {
    const d = list('camera2 0, facing back', 'camera2 1, facing front', 'camera2 2, facing back');
    expect(pickCamera(d, 'id2')?.deviceId).toBe('id2');
    expect(pickCamera(d, 'gone')?.deviceId).toBe('id0');
    // A front camera is never picked, even if remembered.
    expect(pickCamera(d, 'id1')?.deviceId).toBe('id0');
  });

  it('leaves the choice to the browser without labelled back cameras', () => {
    expect(pickCamera(list('Integrated Camera (04f2:b6d9)'))).toBeUndefined();
    expect(pickCamera(list('', ''))).toBeUndefined();
  });
});
