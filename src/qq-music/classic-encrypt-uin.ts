import { parseOfficialQQMusicProfileIdentity } from "./user-input";

const BASE64_TO_ENCRYPT_UIN: Readonly<Record<string, string>> = Object.freeze({
  "0": "P",
  "1": "k",
  "2": "s",
  "3": "l",
  "4": "F",
  "5": "q",
  "=": "*",
  A: "n",
  D: "e",
  E: "6",
  I: "-",
  M: "o",
  N: "7",
  O: "N",
  Q: "v",
  T: "K",
  U: "4",
  Y: "C",
  c: "S",
  g: "c",
  j: "w",
  k: "E",
  w: "z",
  x: "5",
  y: "A",
  z: "i",
});

const ENCRYPT_UIN_TO_BASE64 = invertMapping(BASE64_TO_ENCRYPT_UIN);
const CLASSIC_QQ_LENGTHS = new Set([8, 12, 16]);
const WECHAT_ENCRYPT_UIN_LENGTH = 28;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const QQ_MIN_DIGITS = 5;
const QQ_MAX_DIGITS = 12;
const WECHAT_INTERNAL_ID_DIGITS = 19;

export type ClassicEncryptUinErrorCode =
  | "unsupported-format"
  | "invalid-profile-url"
  | "unknown-character"
  | "invalid-base64"
  | "non-decimal"
  | "invalid-identifier-length";

export type ClassicEncryptUinFormat = "classic-qq-short" | "wechat-28";
export type ClassicEncryptUinIdentityKind = "qq-number-candidate" | "wxuin-candidate";
export type ClassicEncryptUinInputKind =
  | "raw-encrypt-uin"
  | "profile-url-encrypt-uin"
  | "numeric-identifier"
  | "profile-url-numeric";
export type ClassicEncryptUinResolution = "local" | "network";

export class ClassicEncryptUinError extends Error {
  constructor(
    public readonly code: ClassicEncryptUinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClassicEncryptUinError";
  }
}

export interface ClassicEncryptUinDecoded {
  format: ClassicEncryptUinFormat;
  identityKind: ClassicEncryptUinIdentityKind;
  encryptUin: string;
  identifier: string;
  maskedIdentifier: string;
}

export type ClassicEncryptUinExperimentInput =
  | {
    inputKind: "raw-encrypt-uin" | "profile-url-encrypt-uin";
    resolution: "local";
    encryptUin: string;
  }
  | {
    inputKind: "numeric-identifier" | "profile-url-numeric";
    resolution: "network";
    identifier: string;
    identityKind: ClassicEncryptUinIdentityKind;
  };

/**
 * Classifies one manually supplied experiment value without network access.
 * Profile URLs are deliberately limited to known HTTPS QQ Music forms. This
 * parser does not follow redirects or accept generic URLs.
 */
export function parseClassicEncryptUinExperimentInput(input: string): ClassicEncryptUinExperimentInput {
  const normalized = typeof input === "string" ? input.trim() : "";
  if (!normalized) {
    throw new ClassicEncryptUinError("unsupported-format", "请输入 EncryptUin、QQ 音乐个人主页链接或十进制候选标识。");
  }
  if (/^\d+$/.test(normalized)) {
    return {
      inputKind: "numeric-identifier",
      resolution: "network",
      identifier: normalized,
      identityKind: identityKindForIdentifier(normalized),
    };
  }
  if (/^(?:https?:)?\/\//i.test(normalized)) return parseOfficialProfileUrl(normalized);
  const decoded = decodeClassicEncryptUin(normalized);
  return {
    inputKind: "raw-encrypt-uin",
    resolution: "local",
    encryptUin: decoded.encryptUin,
  };
}

/**
 * Decodes only the frozen substitution formats proven by local owned-account
 * experiments: classic QQ short tokens and 28-character WeChat-login tokens.
 * It deliberately rejects every other opaque/new-format identifier.
 */
export function decodeClassicEncryptUin(input: string): ClassicEncryptUinDecoded {
  const encryptUin = typeof input === "string" ? input.trim() : "";
  if (!CLASSIC_QQ_LENGTHS.has(encryptUin.length) && encryptUin.length !== WECHAT_ENCRYPT_UIN_LENGTH) {
    throw new ClassicEncryptUinError(
      "unsupported-format",
      "不支持此格式；仅支持经典 QQ 短格式或严格可解码的 28 位 QQ 音乐微信格式。",
    );
  }

  let base64 = "";
  for (const character of encryptUin) {
    if (!Object.hasOwn(ENCRYPT_UIN_TO_BASE64, character)) {
      throw new ClassicEncryptUinError(
        "unknown-character",
        "不支持此格式；输入包含经典字符表之外的字符。",
      );
    }
    base64 += ENCRYPT_UIN_TO_BASE64[character];
  }

  if (!BASE64_PATTERN.test(base64)) {
    throw new ClassicEncryptUinError(
      "invalid-base64",
      "不支持此格式；逆替换结果不是严格的标准 Base64。",
    );
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) {
    throw new ClassicEncryptUinError(
      "invalid-base64",
      "不支持此格式；逆替换结果不是规范 Base64。",
    );
  }
  if ([...bytes].some((value) => value < 0x30 || value > 0x39)) {
    throw new ClassicEncryptUinError(
      "non-decimal",
      "不支持此格式；解码结果不是纯十进制标识。",
    );
  }

  const identifier = bytes.toString("ascii");
  const identityKind = classifyIdentifier(encryptUin.length, identifier);
  return {
    format: identityKind === "qq-number-candidate" ? "classic-qq-short" : "wechat-28",
    identityKind,
    encryptUin,
    identifier,
    maskedIdentifier: maskMusicIdentifier(identifier, identityKind),
  };
}

/** Test/support inverse for the same frozen classic character table. */
export function encodeClassicEncryptUin(identifier: string): string {
  const normalized = typeof identifier === "string" ? identifier.trim() : "";
  if (!/^\d+$/.test(normalized)) {
    throw new ClassicEncryptUinError(
      "non-decimal",
      "候选标识必须是纯十进制数字。",
    );
  }
  requireEncodableIdentifier(normalized);
  const base64 = Buffer.from(normalized, "ascii").toString("base64");
  let encryptUin = "";
  for (const character of base64) {
    if (!Object.hasOwn(BASE64_TO_ENCRYPT_UIN, character)) {
      throw new ClassicEncryptUinError(
        "unsupported-format",
        "该候选标识无法使用冻结字符表编码。",
      );
    }
    encryptUin += BASE64_TO_ENCRYPT_UIN[character];
  }
  return encryptUin;
}

export function maskMusicIdentifier(
  identifier: string,
  identityKind: ClassicEncryptUinIdentityKind,
): string {
  if (identityKind === "wxuin-candidate") {
    return `${identifier.slice(0, 3)}***${identifier.slice(-3)}`;
  }
  if (identifier.length <= 5) return `${identifier.slice(0, 1)}****${identifier.slice(-1)}`;
  return `${identifier.slice(0, 2)}****${identifier.slice(-2)}`;
}

function classifyIdentifier(
  encryptUinLength: number,
  identifier: string,
): ClassicEncryptUinIdentityKind {
  if (CLASSIC_QQ_LENGTHS.has(encryptUinLength)) {
    if (identifier.length >= QQ_MIN_DIGITS && identifier.length <= QQ_MAX_DIGITS && !identifier.startsWith("0")) {
      return "qq-number-candidate";
    }
    throw new ClassicEncryptUinError(
      "invalid-identifier-length",
      `不支持此格式；QQ 号应为 ${QQ_MIN_DIGITS} 到 ${QQ_MAX_DIGITS} 位且不能以 0 开头。`,
    );
  }
  if (encryptUinLength === WECHAT_ENCRYPT_UIN_LENGTH
    && identifier.length === WECHAT_INTERNAL_ID_DIGITS
    && !identifier.startsWith("0")) {
    return "wxuin-candidate";
  }
  throw new ClassicEncryptUinError(
    "invalid-identifier-length",
    "不支持此格式；28 位微信格式必须严格解码为 19 位且非 0 开头的 QQ 音乐内部 ID。",
  );
}

function requireEncodableIdentifier(identifier: string): void {
  identityKindForIdentifier(identifier);
}

function identityKindForIdentifier(identifier: string): ClassicEncryptUinIdentityKind {
  if (identifier.length >= QQ_MIN_DIGITS
    && identifier.length <= QQ_MAX_DIGITS
    && !identifier.startsWith("0")) return "qq-number-candidate";
  if (identifier.length === WECHAT_INTERNAL_ID_DIGITS && !identifier.startsWith("0")) {
    return "wxuin-candidate";
  }
  throw new ClassicEncryptUinError(
    "invalid-identifier-length",
    "候选标识必须是 5 到 12 位 QQ 号候选，或 19 位 QQ 音乐微信内部 ID 候选，且不能以 0 开头。",
  );
}

function parseOfficialProfileUrl(input: string): ClassicEncryptUinExperimentInput {
  const invalid = () => new ClassicEncryptUinError(
    "invalid-profile-url",
    "不支持此个人主页链接；仅接受已知的 QQ 音乐 HTTPS 个人主页格式。",
  );
  let identityValue: string;
  try {
    identityValue = parseOfficialQQMusicProfileIdentity(input);
  } catch {
    throw invalid();
  }

  if (/^\d+$/.test(identityValue)) {
    return {
      inputKind: "profile-url-numeric",
      resolution: "network",
      identifier: identityValue,
      identityKind: identityKindForIdentifier(identityValue),
    };
  }
  const decoded = decodeClassicEncryptUin(identityValue);
  return {
    inputKind: "profile-url-encrypt-uin",
    resolution: "local",
    encryptUin: decoded.encryptUin,
  };
}

function invertMapping(mapping: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const inverse: Record<string, string> = {};
  for (const [base64, encrypted] of Object.entries(mapping)) {
    if (Object.hasOwn(inverse, encrypted)) throw new Error("Classic EncryptUin character table is not reversible.");
    inverse[encrypted] = base64;
  }
  return Object.freeze(inverse);
}
