const trim = (value: number, digits: number) => String(Number(value.toFixed(digits)));

/** 1 KB = 1000 bytes, as app stores and most size tools report. Trailing zeros are dropped: 2 MB, 1.5 MB. */
export function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs < 1000) return `${bytes} B`;
  if (abs < 1_000_000) return `${trim(bytes / 1000, abs < 10_000 ? 1 : 0)} KB`;
  return `${trim(bytes / 1_000_000, 2)} MB`;
}

export const formatMs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
