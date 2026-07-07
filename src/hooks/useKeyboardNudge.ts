import { useEffect, useRef } from "react";
import { Keyboard, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView } from "react-native";

/** iOS keyboard auto-insets scroll the focused input flush against the
 * keyboard's top edge. This nudges the scroll a little further once the
 * keyboard is up, so the input floats with some breathing room. Debounced so
 * overlapping keyboard events don't stack nudges. */
export function useKeyboardNudge(scrollRef: React.RefObject<ScrollView | null>, extra = 12) {
  const offsetYRef = useRef(0);
  const lastNudgeAtRef = useRef(0);

  useEffect(() => {
    const subscription = Keyboard.addListener("keyboardDidShow", () => {
      const now = Date.now();
      if (now - lastNudgeAtRef.current < 500) return;
      lastNudgeAtRef.current = now;
      scrollRef.current?.scrollTo({ y: offsetYRef.current + extra, animated: true });
    });
    return () => subscription.remove();
  }, [extra, scrollRef]);

  // Attach to the ScrollView (with scrollEventThrottle) so the nudge knows
  // where the auto-inset scroll landed.
  function onScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    offsetYRef.current = event.nativeEvent.contentOffset.y;
  }

  return { onScroll };
}
