/**
 * Where Pop (the character + its bubble, one box) stands: next to the thing
 * it points at, NEVER over it, inside the viewport. Pure, so it is
 * table-tested.
 *
 *            top
 *        ┌────────┐
 *   left │ target │ right        each side is tried (the preferred one first,
 *        └────────┘              then by free space); a side "fits" when the
 *          bottom                whole box is on screen beside the target.
 *
 * When no side fits (a big target, a small phone), a viewport corner that
 * does not touch the target is used — or, failing that, the corner that
 * covers the least of it.
 */

type Box = { readonly width: number; readonly height: number };
type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Side = 'top' | 'bottom' | 'left' | 'right';
type Placed = { readonly x: number; readonly y: number; readonly side: Side | 'corner' };
type PlacementPreference = 'auto' | 'top' | 'bottom' | 'left' | 'right' | 'center';

type PlaceOptions = {
  /** Space kept from the viewport edges. */
  margin?: number;
  /** Space between the target and the box. */
  gap?: number;
  /** How much the target is grown first (the spotlight's padding + ring). */
  avoid?: number;
};

const SIDES: readonly Side[] = ['bottom', 'top', 'right', 'left'];

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max);
}

function placeGuide(
  viewport: Box,
  box: Box,
  target: Rect | null,
  preference: PlacementPreference = 'auto',
  options: PlaceOptions = {},
): Placed {
  const margin = options.margin ?? 12;
  const gap = options.gap ?? 14;
  const avoid = options.avoid ?? 10;
  const maxX = viewport.width - box.width - margin;
  const maxY = viewport.height - box.height - margin;
  const clampX = (x: number) => clamp(x, margin, maxX);
  const clampY = (y: number) => clamp(y, margin, maxY);

  const corners: Placed[] = [
    { x: clampX(maxX), y: clampY(maxY), side: 'corner' },
    { x: clampX(margin), y: clampY(maxY), side: 'corner' },
    { x: clampX(maxX), y: clampY(margin), side: 'corner' },
    { x: clampX(margin), y: clampY(margin), side: 'corner' },
  ];

  if (target === null || preference === 'center') {
    // Talking, not pointing: bottom-right on a computer, bottom-centre on a phone.
    const phone = viewport.width < 640;
    return { x: phone ? clampX((viewport.width - box.width) / 2) : corners[0].x, y: corners[0].y, side: 'corner' };
  }

  const t: Rect = {
    x: target.x - avoid,
    y: target.y - avoid,
    width: target.width + 2 * avoid,
    height: target.height + 2 * avoid,
  };
  const centreX = t.x + t.width / 2;
  const centreY = t.y + t.height / 2;

  const candidate = (side: Side): Placed & { fits: boolean } => {
    switch (side) {
      case 'bottom': {
        const y = t.y + t.height + gap;
        return { x: clampX(centreX - box.width / 2), y, side, fits: y + box.height <= viewport.height - margin };
      }
      case 'top': {
        const y = t.y - gap - box.height;
        return { x: clampX(centreX - box.width / 2), y, side, fits: y >= margin };
      }
      case 'right': {
        const x = t.x + t.width + gap;
        return { x, y: clampY(centreY - box.height / 2), side, fits: x + box.width <= viewport.width - margin };
      }
      case 'left': {
        const x = t.x - gap - box.width;
        return { x, y: clampY(centreY - box.height / 2), side, fits: x >= margin };
      }
    }
  };

  // Free space beyond each side, minus what the box needs there.
  const room: Record<Side, number> = {
    bottom: viewport.height - (t.y + t.height) - box.height,
    top: t.y - box.height,
    right: viewport.width - (t.x + t.width) - box.width,
    left: t.x - box.width,
  };
  const order = [...SIDES].sort((a, b) => room[b] - room[a]);
  if (preference !== 'auto') order.sort((a, b) => Number(b === preference) - Number(a === preference));

  for (const side of order) {
    const placed = candidate(side);
    const rect = { x: placed.x, y: placed.y, width: box.width, height: box.height };
    if (placed.fits && overlapArea(rect, t) === 0) return { x: placed.x, y: placed.y, side };
  }

  let best = corners[0];
  let bestOverlap = Infinity;
  for (const corner of corners) {
    const overlap = overlapArea({ x: corner.x, y: corner.y, width: box.width, height: box.height }, t);
    if (overlap < bestOverlap) {
      best = corner;
      bestOverlap = overlap;
    }
  }
  return best;
}

export { overlapArea, placeGuide };
export type { Box, Placed, PlacementPreference, Rect, Side };
