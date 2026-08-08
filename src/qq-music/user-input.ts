export type QQMusicNormalizedUserInput =
  | { kind: "numeric-uin"; value: string }
  | { kind: "encrypt-uin"; value: string };

/**
 * Production target parsing is deliberately independent from the optional
 * classic EncryptUin decoding experiment. Scanning accepts any established
 * opaque EncryptUin shape; it never requires the value to be reversible.
 */
export function normalizeQQMusicUserInput(input: string): QQMusicNormalizedUserInput {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) throw new Error("QQ Music user input is required.");
  if (/^\d+$/.test(trimmed)) return { kind: "numeric-uin", value: trimmed };

  const value = /^(?:https?:)?\/\//i.test(trimmed)
    ? parseOfficialQQMusicProfileIdentity(trimmed)
    : trimmed;
  if (/^\d+$/.test(value)) return { kind: "numeric-uin", value };
  requireOpaqueEncryptUin(value);
  return { kind: "encrypt-uin", value };
}

/** Extracts one identity from an exact, non-fetching QQ Music profile URL. */
export function parseOfficialQQMusicProfileIdentity(input: string): string {
  const invalid = () => new Error("Unsupported QQ Music profile URL.");
  if (typeof input !== "string" || !/^https:\/\//i.test(input) || /%(?![\da-f]{2})/i.test(input)) {
    throw invalid();
  }

  const authorityStart = input.indexOf("://") + 3;
  const authorityEndOffset = input.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = authorityEndOffset < 0 ? input.length : authorityStart + authorityEndOffset;
  const authority = input.slice(authorityStart, authorityEnd);
  // Requiring the raw authority to be exactly the host rejects userinfo,
  // lookalikes, trailing dots, numeric ports, and an explicit empty port.
  if (authority.toLowerCase() !== "y.qq.com") throw invalid();

  const pathEndOffset = input.slice(authorityEnd).search(/[?#]/);
  const pathEnd = pathEndOffset < 0 ? input.length : authorityEnd + pathEndOffset;
  const rawPath = input.slice(authorityEnd, pathEnd);
  if (hasDotSegment(rawPath)) throw invalid();

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid();
  }
  if (url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "y.qq.com"
    || url.username
    || url.password
    || url.port
    || url.hash
    || url.searchParams.has("id")) throw invalid();

  const pathMatch = url.pathname.match(/^\/n\/ryqq\/profile\/([^/]+)\/?$/);
  let identity: string | undefined;
  if (pathMatch) {
    if (url.search) throw invalid();
    try {
      identity = decodeURIComponent(pathMatch[1]);
    } catch {
      throw invalid();
    }
  } else if (/^\/n\/ryqq_v2\/profile\/?$/.test(url.pathname)
    || url.pathname === "/portal/profile.html") {
    const values = url.searchParams.getAll("uin");
    if (values.length !== 1 || [...url.searchParams.keys()].some((key) => key !== "uin")) throw invalid();
    identity = values[0];
  } else {
    throw invalid();
  }
  if (!identity || identity !== identity.trim()) throw invalid();
  return identity;
}

function requireOpaqueEncryptUin(value: string): void {
  if (!/^[A-Za-z0-9*_.-]{4,128}$/.test(value)) {
    throw new Error("EncryptUin contains unsupported characters.");
  }
}

function hasDotSegment(rawPath: string): boolean {
  for (const rawSegment of rawPath.split("/")) {
    let segment = rawSegment;
    for (let depth = 0; depth < 4; depth += 1) {
      if (segment === "." || segment === "..") return true;
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return true;
      }
      if (decoded === segment) break;
      segment = decoded;
    }
    if (segment === "." || segment === "..") return true;
  }
  return false;
}
