export const ADMIN_SWIPE_THRESHOLD = 56;
export const ADMIN_SWIPE_AXIS_LOCK = 10;

export type SwipeStart = { x: number; y: number; pointerId: number };

export function swipeProgress(start: SwipeStart, x: number, y: number) {
  const dx = x - start.x;
  const dy = y - start.y;
  const horizontal = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.1;
  return {
    dx: Math.max(0, dx),
    dy,
    horizontal: Math.abs(dx) >= ADMIN_SWIPE_AXIS_LOCK && horizontal,
    complete: horizontal && dx >= ADMIN_SWIPE_THRESHOLD,
  };
}

export function swipeAllowedTarget(target: EventTarget | null) {
  return !(target instanceof Element) || !target.closest(
    "textarea,input,select,button,a,audio,video,[contenteditable='true'],[data-no-swipe]",
  );
}
