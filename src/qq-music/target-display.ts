import { ClassicEncryptUinError, decodeClassicEncryptUin } from "./classic-encrypt-uin";
import { normalizeQQMusicUserInput } from "./user-input";

export type QQMusicTargetDisplayKind = "qq-number" | "wechat-user" | "encrypt-uin";

export interface QQMusicTargetDisplay {
  kind: QQMusicTargetDisplayKind;
  label: string;
  /** The normalized identity used for an optional public-profile lookup. */
  profileLookup: string;
}

/**
 * Creates presentation-only identity text without changing the canonical
 * EncryptUin used by task generations, checkpoints, matching, or storage.
 */
export function describeQQMusicTarget(input: string): QQMusicTargetDisplay {
  const normalized = normalizeQQMusicUserInput(input);
  if (normalized.kind === "numeric-uin") {
    return numericDisplay(normalized.value);
  }

  try {
    const decoded = decodeClassicEncryptUin(normalized.value);
    if (decoded.identityKind === "wxuin-candidate") {
      return {
        kind: "wechat-user",
        label: "微信用户",
        profileLookup: decoded.identifier,
      };
    }
    return {
      kind: "qq-number",
      label: `QQ ${decoded.identifier}`,
      profileLookup: decoded.identifier,
    };
  } catch (error) {
    if (!(error instanceof ClassicEncryptUinError)) throw error;
    return {
      kind: "encrypt-uin",
      label: `EncryptUin ${normalized.value}`,
      profileLookup: normalized.value,
    };
  }
}

/**
 * Uses QQ's public avatar CDN only when the presentation identity is a
 * concrete numeric QQ. Opaque EncryptUin values and WeChat identities must
 * never be inserted into the QQ-number avatar route.
 */
export function qqMusicTargetAvatarUrl(display: QQMusicTargetDisplay): string | undefined {
  if (display.kind !== "qq-number" || !/^\d{5,20}$/.test(display.profileLookup)) return undefined;
  const url = new URL("https://q1.qlogo.cn/g");
  url.searchParams.set("b", "qq");
  url.searchParams.set("nk", display.profileLookup);
  url.searchParams.set("s", "100");
  return url.toString();
}

function numericDisplay(value: string): QQMusicTargetDisplay {
  return { kind: "qq-number", label: `QQ ${value}`, profileLookup: value };
}
