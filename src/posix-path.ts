/**
 * A tiny, node-free POSIX `path` — the browser-safe substitute for `node:path`
 * inside the in-browser audit engine (`scan-core.ts` / `scan-files.ts` /
 * `test-coverage-files.ts` and the core detectors they reach). A Vite bundle of
 * that engine must not pull `node:path`, so these are pure string ops.
 *
 * The audit engine's file-map keys are always POSIX (`/`-separated), and the
 * disk-side `scanPlugin` feeds it absolute POSIX roots (`resolve(dir)` on Linux),
 * so a faithful port of Node's `path.posix` algorithm is byte-identical to
 * `node:path` for every input the engine passes — which is exactly what the
 * parity firewall (`scan-files.test.ts`) proves. `resolve` deliberately falls
 * back to `/` (never `process.cwd()`) so it stays pure and process-free; every
 * call site passes an absolute first segment, so the fallback is never reached.
 *
 * NOTE — the functions below are VERBATIM ports of Node's `lib/path.js` POSIX
 * implementations (charCode scan, `normalizeString`, `basename`, `relative`).
 * Their branch depth / cyclomatic complexity is inherent to that battle-tested
 * algorithm; rewriting it to satisfy the complexity linters would risk a subtle
 * behavioural divergence from `node:path` (which the disk-vs-browser parity gate
 * relies on), so the metric rules are disabled for this file only.
 */
/* eslint-disable complexity, max-depth, sonarjs/cognitive-complexity, sonarjs/nested-control-flow, no-param-reassign -- verbatim Node `path.js` port: it reassigns its own string parameters, and a string is copied by value so nothing escapes to the caller. Rewriting that away would diverge from the algorithm the parity gate pins. */

const SLASH = 47; // '/'
const DOT = 46; // '.'

/**
 * The core POSIX normalize pass (ported from Node's `normalizeString`): collapse
 * `.`/`..`/`//` in a slash-separated path with no leading root. `allowAboveRoot`
 * keeps leading `..` segments (used for a relative path).
 */
function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === SLASH) break;
    else code = SLASH;

    if (code === SLASH) {
      if (lastSlash === i - 1 || dots === 1) {
        // no-op: a `//` or `.` segment
      } else if (dots === 2) {
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== DOT ||
          res.charCodeAt(res.length - 2) !== DOT
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex === -1) {
              res = "";
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? "/.." : "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += "/" + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

/** POSIX `path.isAbsolute`. */
export function isAbsolute(path: string): boolean {
  return path.length > 0 && path.charCodeAt(0) === SLASH;
}

/** POSIX `path.normalize`. */
export function normalize(path: string): string {
  if (path.length === 0) return ".";
  const isAbs = path.charCodeAt(0) === SLASH;
  const trailingSep = path.charCodeAt(path.length - 1) === SLASH;
  path = normalizeString(path, !isAbs);
  if (path.length === 0) {
    if (isAbs) return "/";
    return trailingSep ? "./" : ".";
  }
  if (trailingSep) path += "/";
  return isAbs ? `/${path}` : path;
}

/** POSIX `path.join`. */
export function join(...parts: string[]): string {
  if (parts.length === 0) return ".";
  let joined: string | undefined;
  for (const part of parts) {
    if (part.length > 0) {
      if (joined === undefined) joined = part;
      else joined += `/${part}`;
    }
  }
  if (joined === undefined) return ".";
  return normalize(joined);
}

/**
 * POSIX `path.resolve`. Right-to-left until an absolute segment is found, then
 * normalize. The `i === -1` fallback is `/` (not `process.cwd()`) so this stays
 * pure; every engine call site passes an absolute first segment.
 */
export function resolve(...parts: string[]): string {
  let resolvedPath = "";
  let resolvedAbsolute = false;
  for (let i = parts.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    const path = i >= 0 ? parts[i] : "/";
    if (path.length === 0) continue;
    resolvedPath = `${path}/${resolvedPath}`;
    resolvedAbsolute = path.charCodeAt(0) === SLASH;
  }
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
  if (resolvedAbsolute) return `/${resolvedPath}`;
  return resolvedPath.length > 0 ? resolvedPath : ".";
}

/** POSIX `path.dirname`. */
export function dirname(path: string): string {
  if (path.length === 0) return ".";
  const hasRoot = path.charCodeAt(0) === SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return path.slice(0, end);
}

/** POSIX `path.basename` (with an optional `suffix` to strip, like `node:path`). */
export function basename(path: string, suffix?: string): string {
  let start = 0;
  let end = -1;
  let matchedSlash = true;

  if (
    suffix !== undefined &&
    suffix.length > 0 &&
    suffix.length <= path.length
  ) {
    if (suffix === path) return "";
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === SLASH) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false;
          firstNonSlashEnd = i + 1;
        }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) {
            if (--extIdx === -1) {
              end = i;
            }
          } else {
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }

  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === SLASH) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return "";
  return path.slice(start, end);
}

/** POSIX `path.relative`. */
export function relative(from: string, to: string): string {
  if (from === to) return "";
  from = resolve(from);
  to = resolve(to);
  if (from === to) return "";

  const fromStart = 1;
  const fromEnd = from.length;
  const fromLen = fromEnd - fromStart;
  const toStart = 1;
  const toLen = to.length - toStart;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    else if (fromCode === SLASH) lastCommonSep = i;
  }
  if (i === length) {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === SLASH)
        return to.slice(toStart + i + 1);
      if (i === 0) return to.slice(toStart + i);
    } else if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === SLASH) lastCommonSep = i;
      else if (i === 0) lastCommonSep = 0;
    }
  }
  let out = "";
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === SLASH) {
      out += out.length === 0 ? ".." : "/..";
    }
  }
  return `${out}${to.slice(toStart + lastCommonSep)}`;
}
