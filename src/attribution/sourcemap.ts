import { AnyMap, decodedMappings, type SourceMapInput } from "@jridgewell/trace-mapping";

/** Key for lines no source can be found for; in a Metro bundle, the prelude and the startup calls. */
export const GENERATED = "\0generated";

/**
 * Splits a generated file's bytes among the original sources its source map points at; the totals
 * add up to the file's size.
 *
 * Each mapping segment owns the text from its column to the next segment's. Metro writes one module
 * per line, wrapped in `__d(function(…){` … `},id,[deps]);` that maps nowhere, so a line's unmapped
 * text and its newline go to the source owning most of that line: every module brings its wrapper.
 *
 * Some modules have no mappings at all; Metro emits JSON and asset modules that way. Metro lists
 * sources in bundle order, so a line with no mappings between the lines of sources 510 and 512 is
 * source 511, if 511 has no mappings of its own. A line no such source fits is GENERATED.
 */
export function bytesBySource(code: string, map: SourceMapInput): Map<string, number> {
  const traced = new AnyMap(map);
  const mappings = decodedMappings(traced);
  const sources = traced.sources;
  const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

  const lines = code.split("\n").map((line, i, all) => {
    const owned = new Map<number, number>();
    let unmapped = i < all.length - 1 ? 1 : 0;
    let cursor = 0;
    let owner: number | undefined;
    const take = (end: number) => {
      if (end <= cursor) return;
      const bytes = bytesOf(line.slice(cursor, end));
      if (owner === undefined) unmapped += bytes;
      else owned.set(owner, (owned.get(owner) ?? 0) + bytes);
      cursor = end;
    };
    for (const segment of mappings[i] ?? []) {
      take(Math.min(segment[0], line.length));
      owner = segment.length >= 4 ? segment[1] : undefined;
    }
    take(line.length);

    let main = -1;
    let most = 0;
    for (const [source, bytes] of owned) if (bytes > most) [main, most] = [source, bytes];
    return { owned, unmapped, main };
  });

  // Fill in lines without mappings from the sources that have none, keeping bundle order.
  const claimed = new Set(lines.flatMap((line) => [...line.owned.keys()]));
  const nextMain: number[] = [];
  for (let i = lines.length - 1, next = sources.length; i >= 0; i--) {
    nextMain[i] = next;
    if (lines[i]!.main !== -1) next = lines[i]!.main;
  }
  let previous = -1;
  lines.forEach((line, i) => {
    if (line.main === -1) {
      for (let candidate = previous + 1; candidate < nextMain[i]!; candidate++) {
        if (!claimed.has(candidate)) {
          claimed.add(candidate);
          line.main = candidate;
          break;
        }
      }
    }
    if (line.main !== -1) previous = line.main;
  });

  const totals = new Map<string, number>();
  const add = (key: string, bytes: number) => bytes && totals.set(key, (totals.get(key) ?? 0) + bytes);
  for (const line of lines) {
    for (const [source, bytes] of line.owned) add(sources[source] ?? GENERATED, bytes);
    add(line.main === -1 ? GENERATED : (sources[line.main] ?? GENERATED), line.unmapped);
  }
  return totals;
}
