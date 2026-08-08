import { createHash } from "node:crypto";

const PREFIX_INDEXES = [23, 14, 6, 36, 16, 7, 19] as const;
const SUFFIX_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5] as const;
const SCRAMBLE_VALUES = [
  89, 39, 179, 150, 218, 82, 58, 252, 177, 52,
  186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
] as const;

/**
 * Builds the request-integrity token used by selected musics.fcg calls.
 * It is a deterministic signature over the exact JSON payload, not encryption.
 */
export function zzcSign(payload: string | Uint8Array): string {
  const digest = createHash("sha1").update(payload).digest("hex").toUpperCase();
  const prefix = pick(digest, PREFIX_INDEXES);
  const suffix = pick(digest, SUFFIX_INDEXES);
  const scrambled = Buffer.from(SCRAMBLE_VALUES.map((value, index) =>
    value ^ Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16)
  ));
  const encoded = scrambled.toString("base64").replace(/[\\/+=]/g, "");
  return `zzc${prefix}${encoded}${suffix}`.toLowerCase();
}

function pick(value: string, indexes: readonly number[]): string {
  return indexes.map((index) => value[index]).join("");
}
