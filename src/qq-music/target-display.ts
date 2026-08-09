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

function numericDisplay(value: string): QQMusicTargetDisplay {
  return { kind: "qq-number", label: `QQ ${value}`, profileLookup: value };
}
