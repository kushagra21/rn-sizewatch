import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { AssetSize, PlatformMeasurement, Sizes } from "../core/types.js";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** Compresses on libuv's thread pool, at the levels CDNs use for static files (gzip 9, brotli 11). */
export async function sizesOf(data: Buffer): Promise<Sizes> {
  const [gzipped, brotlied] = await Promise.all([
    gzipAsync(data, { level: 9 }),
    brotliAsync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
  ]);
  return { raw: data.length, gzip: gzipped.length, brotli: brotlied.length };
}

/** Every file Metro copied into the assets folder, biggest first. */
export function measureAssets(dir: string): PlatformMeasurement["assets"] {
  const files: AssetSize[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push({ path: relative(dir, path).split(sep).join("/"), bytes: statSync(path).size });
    }
  };
  if (existsSync(dir)) walk(dir);
  files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return { bytes: files.reduce((sum, f) => sum + f.bytes, 0), count: files.length, files };
}
