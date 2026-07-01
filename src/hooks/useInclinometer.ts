import { DeviceMotion } from "expo-sensors";
import { useCallback, useEffect, useMemo, useState } from "react";

type Attitude = {
  pitch: number;
  roll: number;
};

type Offset = {
  pitch: number;
  roll: number;
};

const radToDeg = (value: number) => Math.round((value * 180) / Math.PI);

export function useInclinometer() {
  const [available, setAvailable] = useState(false);
  const [attitude, setAttitude] = useState<Attitude>({ pitch: 0, roll: 0 });
  const [offset, setOffset] = useState<Offset>({ pitch: 0, roll: 0 });

  useEffect(() => {
    let mounted = true;

    DeviceMotion.isAvailableAsync()
      .then((isAvailable) => {
        if (!mounted) return;
        setAvailable(isAvailable);
      })
      .catch(() => setAvailable(false));

    DeviceMotion.setUpdateInterval(160);
    const subscription = DeviceMotion.addListener((event) => {
      const rotation = event.rotation;
      if (!rotation) return;
      setAttitude({
        pitch: radToDeg(rotation.beta ?? 0),
        roll: radToDeg(rotation.gamma ?? 0)
      });
    });

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  const calibrated = useMemo(
    () => ({
      pitch: attitude.pitch - offset.pitch,
      roll: attitude.roll - offset.roll
    }),
    [attitude, offset]
  );

  const gradePercent = useMemo(() => Math.round(Math.tan((calibrated.pitch * Math.PI) / 180) * 100), [calibrated.pitch]);

  const resetZero = useCallback(() => {
    setOffset(attitude);
  }, [attitude]);

  return {
    available,
    pitch: calibrated.pitch,
    roll: calibrated.roll,
    gradePercent,
    resetZero
  };
}
