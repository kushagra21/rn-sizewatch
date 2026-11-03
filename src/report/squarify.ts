export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Squarified treemap layout (Bruls, Huizing and van Wijk): splits the rectangle into one rectangle
 * per value, in the same order, with areas proportional to the values and shapes close to square.
 * Values should be sorted biggest first; zero or negative values get an empty rectangle.
 *
 * Self-contained on purpose: the report embeds this function's source to lay out the treemap in
 * the browser.
 */
export function squarify(values: number[], x: number, y: number, w: number, h: number): Rect[] {
  const rects = values.map(() => ({ x, y, w: 0, h: 0 }));
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total <= 0 || w <= 0 || h <= 0) return rects;
  const scale = (w * h) / total;
  const indexes = values.map((_, i) => i).filter((i) => values[i]! > 0);
  const area = (i: number) => values[i]! * scale;

  // How far from square the worst rectangle in a row would be.
  const worst = (sum: number, min: number, max: number, side: number) => Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));

  let start = 0;
  while (start < indexes.length) {
    const side = Math.min(w, h);
    let sum = area(indexes[start]!);
    let min = sum;
    let max = sum;
    let end = start + 1;
    while (end < indexes.length) {
      const next = area(indexes[end]!);
      const grown = worst(sum + next, Math.min(min, next), Math.max(max, next), side);
      if (grown > worst(sum, min, max, side)) break;
      sum += next;
      min = Math.min(min, next);
      max = Math.max(max, next);
      end++;
    }

    // The row runs along the shorter side; its thickness makes its area right.
    const thickness = sum / side;
    let offset = 0;
    for (let k = start; k < end; k++) {
      const length = area(indexes[k]!) / thickness;
      rects[indexes[k]!] = w >= h ? { x, y: y + offset, w: thickness, h: length } : { x: x + offset, y, w: length, h: thickness };
      offset += length;
    }
    if (w >= h) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
    start = end;
  }
  return rects;
}
