var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/build-info.ts
function getBuildInfo() {
  return BUILD_INFO;
}
var BUILD_INFO;
var init_build_info = __esm({
  "src/build-info.ts"() {
    BUILD_INFO = {
      commit: "6a9c55f",
      buildId: "test-20260703-153052-6a9c55f",
      builtAt: "2026-07-03T15:30:52Z",
      channel: "trunk"
    };
  }
});

// src/logger.ts
function formatParts(parts) {
  return parts.map((part) => String(part)).join(" ");
}
function splitMessageLines(message) {
  const normalized = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length > 0 ? lines : [
    ""
  ];
}
function formatStructuredLine(level, component, message) {
  return `${(/* @__PURE__ */ new Date()).toISOString()} ${level} ${component}  ${message}
`;
}
function log(level, component, ...parts) {
  const message = formatParts(parts);
  const out = level === "INFO" || level === "DEBUG" ? Deno.stdout : Deno.stderr;
  for (const line of splitMessageLines(message)) {
    out.writeSync(encoder.encode(formatStructuredLine(level, component, line)));
  }
}
function logInfo(component, ...parts) {
  log("INFO", component, ...parts);
}
function logDebug(component, ...parts) {
  log("DEBUG", component, ...parts);
}
function logWarn(component, ...parts) {
  log("WARN", component, ...parts);
}
function logError(component, ...parts) {
  log("ERROR", component, ...parts);
}
var encoder;
var init_logger = __esm({
  "src/logger.ts"() {
    encoder = new TextEncoder();
  }
});

// deno:https://jsr.io/@std/internal/1.0.14/_os.ts
function checkWindows() {
  const global = globalThis;
  const platform = global.process?.platform;
  if (typeof platform === "string") return platform.startsWith("win");
  const os = global.Deno?.build?.os;
  if (typeof os === "string") return os === "windows";
  return global.navigator?.platform?.startsWith("Win") ?? false;
}
var init_os = __esm({
  "deno:https://jsr.io/@std/internal/1.0.14/_os.ts"() {
  }
});

// deno:https://jsr.io/@std/internal/1.0.14/os.ts
var isWindows;
var init_os2 = __esm({
  "deno:https://jsr.io/@std/internal/1.0.14/os.ts"() {
    init_os();
    isWindows = checkWindows();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/assert_path.ts
function assertPath(path) {
  if (typeof path !== "string") {
    throw new TypeError(`Path must be a string, received "${JSON.stringify(path)}"`);
  }
}
var init_assert_path = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/assert_path.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/basename.ts
var init_basename = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/basename.ts"() {
    init_assert_path();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/from_file_url.ts
function assertArg(url) {
  url = url instanceof URL ? url : new URL(url);
  if (url.protocol !== "file:") {
    throw new TypeError(`URL must be a file URL: received "${url.protocol}"`);
  }
  return url;
}
var init_from_file_url = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/from_file_url.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/from_file_url.ts
function fromFileUrl(url) {
  url = assertArg(url);
  return decodeURIComponent(url.pathname.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
}
var init_from_file_url2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/from_file_url.ts"() {
    init_from_file_url();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/strip_trailing_separators.ts
function stripTrailingSeparators(segment, isSep) {
  if (segment.length <= 1) {
    return segment;
  }
  let end = segment.length;
  for (let i = segment.length - 1; i > 0; i--) {
    if (isSep(segment.charCodeAt(i))) {
      end = i;
    } else {
      break;
    }
  }
  return segment.slice(0, end);
}
var init_strip_trailing_separators = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/strip_trailing_separators.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/constants.ts
var CHAR_UPPERCASE_A, CHAR_LOWERCASE_A, CHAR_UPPERCASE_Z, CHAR_LOWERCASE_Z, CHAR_DOT, CHAR_FORWARD_SLASH, CHAR_BACKWARD_SLASH, CHAR_COLON;
var init_constants = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/constants.ts"() {
    CHAR_UPPERCASE_A = 65;
    CHAR_LOWERCASE_A = 97;
    CHAR_UPPERCASE_Z = 90;
    CHAR_LOWERCASE_Z = 122;
    CHAR_DOT = 46;
    CHAR_FORWARD_SLASH = 47;
    CHAR_BACKWARD_SLASH = 92;
    CHAR_COLON = 58;
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/_util.ts
function isPosixPathSeparator(code) {
  return code === CHAR_FORWARD_SLASH;
}
var init_util = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/_util.ts"() {
    init_constants();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/basename.ts
var init_basename2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/basename.ts"() {
    init_basename();
    init_from_file_url2();
    init_strip_trailing_separators();
    init_util();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/_util.ts
function isPosixPathSeparator2(code) {
  return code === CHAR_FORWARD_SLASH;
}
function isPathSeparator(code) {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}
function isWindowsDeviceRoot(code) {
  return code >= CHAR_LOWERCASE_A && code <= CHAR_LOWERCASE_Z || code >= CHAR_UPPERCASE_A && code <= CHAR_UPPERCASE_Z;
}
var init_util2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/_util.ts"() {
    init_constants();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/from_file_url.ts
function fromFileUrl2(url) {
  url = assertArg(url);
  let path = decodeURIComponent(url.pathname.replace(/\//g, "\\").replace(/%(?![0-9A-Fa-f]{2})/g, "%25")).replace(/^\\*([A-Za-z]:)(\\|$)/, "$1\\");
  if (url.hostname !== "") {
    path = `\\\\${url.hostname}${path}`;
  }
  return path;
}
var init_from_file_url3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/from_file_url.ts"() {
    init_from_file_url();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/basename.ts
var init_basename3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/basename.ts"() {
    init_basename();
    init_constants();
    init_strip_trailing_separators();
    init_util2();
    init_from_file_url3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/basename.ts
var init_basename4 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/basename.ts"() {
    init_os2();
    init_basename2();
    init_basename3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/constants.ts
var init_constants2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/constants.ts"() {
    init_os2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/dirname.ts
function assertArg2(path) {
  assertPath(path);
  if (path.length === 0) return ".";
}
var init_dirname = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/dirname.ts"() {
    init_assert_path();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/dirname.ts
function dirname(path) {
  if (path instanceof URL) {
    path = fromFileUrl(path);
  }
  assertArg2(path);
  let end = -1;
  let matchedNonSeparator = false;
  for (let i = path.length - 1; i >= 1; --i) {
    if (isPosixPathSeparator(path.charCodeAt(i))) {
      if (matchedNonSeparator) {
        end = i;
        break;
      }
    } else {
      matchedNonSeparator = true;
    }
  }
  if (end === -1) {
    return isPosixPathSeparator(path.charCodeAt(0)) ? "/" : ".";
  }
  return stripTrailingSeparators(path.slice(0, end), isPosixPathSeparator);
}
var init_dirname2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/dirname.ts"() {
    init_dirname();
    init_strip_trailing_separators();
    init_util();
    init_from_file_url2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/dirname.ts
function dirname2(path) {
  if (path instanceof URL) {
    path = fromFileUrl2(path);
  }
  assertArg2(path);
  const len = path.length;
  let rootEnd = -1;
  let end = -1;
  let matchedSlash = true;
  let offset = 0;
  const code = path.charCodeAt(0);
  if (len > 1) {
    if (isPathSeparator(code)) {
      rootEnd = offset = 1;
      if (isPathSeparator(path.charCodeAt(1))) {
        let j = 2;
        let last = j;
        for (; j < len; ++j) {
          if (isPathSeparator(path.charCodeAt(j))) break;
        }
        if (j < len && j !== last) {
          last = j;
          for (; j < len; ++j) {
            if (!isPathSeparator(path.charCodeAt(j))) break;
          }
          if (j < len && j !== last) {
            last = j;
            for (; j < len; ++j) {
              if (isPathSeparator(path.charCodeAt(j))) break;
            }
            if (j === len) {
              return path;
            }
            if (j !== last) {
              rootEnd = offset = j + 1;
            }
          }
        }
      }
    } else if (isWindowsDeviceRoot(code)) {
      if (path.charCodeAt(1) === CHAR_COLON) {
        rootEnd = offset = 2;
        if (len > 2) {
          if (isPathSeparator(path.charCodeAt(2))) rootEnd = offset = 3;
        }
      }
    }
  } else if (isPathSeparator(code)) {
    return path;
  }
  for (let i = len - 1; i >= offset; --i) {
    if (isPathSeparator(path.charCodeAt(i))) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) {
    if (rootEnd === -1) return ".";
    else end = rootEnd;
  }
  return stripTrailingSeparators(path.slice(0, end), isPosixPathSeparator2);
}
var init_dirname3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/dirname.ts"() {
    init_dirname();
    init_constants();
    init_strip_trailing_separators();
    init_util2();
    init_from_file_url3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/dirname.ts
function dirname3(path) {
  return isWindows ? dirname2(path) : dirname(path);
}
var init_dirname4 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/dirname.ts"() {
    init_os2();
    init_dirname2();
    init_dirname3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/extname.ts
var init_extname = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/extname.ts"() {
    init_constants();
    init_assert_path();
    init_util();
    init_from_file_url2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/extname.ts
var init_extname2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/extname.ts"() {
    init_constants();
    init_assert_path();
    init_util2();
    init_from_file_url3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/extname.ts
var init_extname3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/extname.ts"() {
    init_os2();
    init_extname();
    init_extname2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/format.ts
var init_format = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/format.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/format.ts
var init_format2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/format.ts"() {
    init_format();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/format.ts
var init_format3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/format.ts"() {
    init_format();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/format.ts
var init_format4 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/format.ts"() {
    init_os2();
    init_format2();
    init_format3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/from_file_url.ts
function fromFileUrl3(url) {
  return isWindows ? fromFileUrl2(url) : fromFileUrl(url);
}
var init_from_file_url4 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/from_file_url.ts"() {
    init_os2();
    init_from_file_url2();
    init_from_file_url3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/is_absolute.ts
var init_is_absolute = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/is_absolute.ts"() {
    init_assert_path();
    init_util();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/is_absolute.ts
var init_is_absolute2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/is_absolute.ts"() {
    init_constants();
    init_assert_path();
    init_util2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/is_absolute.ts
var init_is_absolute3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/is_absolute.ts"() {
    init_os2();
    init_is_absolute();
    init_is_absolute2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/normalize.ts
function assertArg4(path) {
  assertPath(path);
  if (path.length === 0) return ".";
}
var init_normalize = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/normalize.ts"() {
    init_assert_path();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/normalize_string.ts
function normalizeString(path, allowAboveRoot, separator, isPathSeparator2) {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (isPathSeparator2(code)) break;
    else code = CHAR_FORWARD_SLASH;
    if (isPathSeparator2(code)) {
      if (lastSlash === i - 1 || dots === 1) {
      } else if (lastSlash !== i - 1 && dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== CHAR_DOT || res.charCodeAt(res.length - 2) !== CHAR_DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf(separator);
            if (lastSlashIndex === -1) {
              res = "";
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length === 2 || res.length === 1) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          if (res.length > 0) res += `${separator}..`;
          else res = "..";
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += separator + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}
var init_normalize_string = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/normalize_string.ts"() {
    init_constants();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/normalize.ts
function normalize(path) {
  if (path instanceof URL) {
    path = fromFileUrl(path);
  }
  assertArg4(path);
  const isAbsolute3 = isPosixPathSeparator(path.charCodeAt(0));
  const trailingSeparator = isPosixPathSeparator(path.charCodeAt(path.length - 1));
  path = normalizeString(path, !isAbsolute3, "/", isPosixPathSeparator);
  if (path.length === 0 && !isAbsolute3) path = ".";
  if (path.length > 0 && trailingSeparator) path += "/";
  if (isAbsolute3) return `/${path}`;
  return path;
}
var init_normalize2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/normalize.ts"() {
    init_normalize();
    init_normalize_string();
    init_util();
    init_from_file_url2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/join.ts
function join(path, ...paths) {
  if (path === void 0) return ".";
  if (path instanceof URL) {
    path = fromFileUrl(path);
  }
  paths = path ? [
    path,
    ...paths
  ] : paths;
  paths.forEach((path2) => assertPath(path2));
  const joined = paths.filter((path2) => path2.length > 0).join("/");
  return joined === "" ? "." : normalize(joined);
}
var init_join = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/join.ts"() {
    init_assert_path();
    init_from_file_url2();
    init_normalize2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/normalize.ts
function normalize2(path) {
  if (path instanceof URL) {
    path = fromFileUrl2(path);
  }
  assertArg4(path);
  const len = path.length;
  let rootEnd = 0;
  let device;
  let isAbsolute3 = false;
  const code = path.charCodeAt(0);
  if (len > 1) {
    if (isPathSeparator(code)) {
      isAbsolute3 = true;
      if (isPathSeparator(path.charCodeAt(1))) {
        let j = 2;
        let last = j;
        for (; j < len; ++j) {
          if (isPathSeparator(path.charCodeAt(j))) break;
        }
        if (j < len && j !== last) {
          const firstPart = path.slice(last, j);
          last = j;
          for (; j < len; ++j) {
            if (!isPathSeparator(path.charCodeAt(j))) break;
          }
          if (j < len && j !== last) {
            last = j;
            for (; j < len; ++j) {
              if (isPathSeparator(path.charCodeAt(j))) break;
            }
            if (j === len) {
              return `\\\\${firstPart}\\${path.slice(last)}\\`;
            } else if (j !== last) {
              device = `\\\\${firstPart}\\${path.slice(last, j)}`;
              rootEnd = j;
            }
          }
        }
      } else {
        rootEnd = 1;
      }
    } else if (isWindowsDeviceRoot(code)) {
      if (path.charCodeAt(1) === CHAR_COLON) {
        device = path.slice(0, 2);
        rootEnd = 2;
        if (len > 2) {
          if (isPathSeparator(path.charCodeAt(2))) {
            isAbsolute3 = true;
            rootEnd = 3;
          }
        }
      }
    }
  } else if (isPathSeparator(code)) {
    return "\\";
  }
  let tail;
  if (rootEnd < len) {
    tail = normalizeString(path.slice(rootEnd), !isAbsolute3, "\\", isPathSeparator);
  } else {
    tail = "";
  }
  if (tail.length === 0 && !isAbsolute3) tail = ".";
  if (tail.length > 0 && isPathSeparator(path.charCodeAt(len - 1))) {
    tail += "\\";
  }
  if (device === void 0) {
    if (isAbsolute3) {
      if (tail.length > 0) return `\\${tail}`;
      else return "\\";
    }
    return tail;
  } else if (isAbsolute3) {
    if (tail.length > 0) return `${device}\\${tail}`;
    else return `${device}\\`;
  }
  return device + tail;
}
var init_normalize3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/normalize.ts"() {
    init_normalize();
    init_constants();
    init_normalize_string();
    init_util2();
    init_from_file_url3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/join.ts
function join2(path, ...paths) {
  if (path instanceof URL) {
    path = fromFileUrl2(path);
  }
  paths = path ? [
    path,
    ...paths
  ] : paths;
  paths.forEach((path2) => assertPath(path2));
  paths = paths.filter((path2) => path2.length > 0);
  if (paths.length === 0) return ".";
  let needsReplace = true;
  let slashCount = 0;
  const firstPart = paths[0];
  if (isPathSeparator(firstPart.charCodeAt(0))) {
    ++slashCount;
    const firstLen = firstPart.length;
    if (firstLen > 1) {
      if (isPathSeparator(firstPart.charCodeAt(1))) {
        ++slashCount;
        if (firstLen > 2) {
          if (isPathSeparator(firstPart.charCodeAt(2))) ++slashCount;
          else {
            needsReplace = false;
          }
        }
      }
    }
  }
  let joined = paths.join("\\");
  if (needsReplace) {
    for (; slashCount < joined.length; ++slashCount) {
      if (!isPathSeparator(joined.charCodeAt(slashCount))) break;
    }
    if (slashCount >= 2) joined = `\\${joined.slice(slashCount)}`;
  }
  return normalize2(joined);
}
var init_join2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/join.ts"() {
    init_assert_path();
    init_util2();
    init_normalize3();
    init_from_file_url3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/join.ts
function join3(path, ...paths) {
  return isWindows ? join2(path, ...paths) : join(path, ...paths);
}
var init_join3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/join.ts"() {
    init_os2();
    init_join();
    init_join2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/normalize.ts
var init_normalize4 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/normalize.ts"() {
    init_os2();
    init_normalize2();
    init_normalize3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/parse.ts
var init_parse = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/parse.ts"() {
    init_constants();
    init_strip_trailing_separators();
    init_assert_path();
    init_util();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/parse.ts
var init_parse2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/parse.ts"() {
    init_constants();
    init_assert_path();
    init_util2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/parse.ts
var init_parse3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/parse.ts"() {
    init_os2();
    init_parse();
    init_parse2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/env.ts
function cwd(errorMessage) {
  const global = globalThis;
  const getCwd = global.process?.cwd ?? global.Deno?.cwd;
  if (typeof getCwd !== "function") {
    throw new TypeError(errorMessage);
  }
  return getCwd();
}
var init_env = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/env.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/resolve.ts
function resolve(...pathSegments) {
  let resolvedPath = "";
  let resolvedAbsolute = false;
  for (let i = pathSegments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    let path;
    if (i >= 0) path = pathSegments[i];
    else {
      path = cwd("Resolved a relative path without a current working directory (CWD)");
    }
    assertPath(path);
    if (path.length === 0) {
      continue;
    }
    resolvedPath = `${path}/${resolvedPath}`;
    resolvedAbsolute = isPosixPathSeparator(path.charCodeAt(0));
  }
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute, "/", isPosixPathSeparator);
  if (resolvedAbsolute) {
    if (resolvedPath.length > 0) return `/${resolvedPath}`;
    else return "/";
  } else if (resolvedPath.length > 0) return resolvedPath;
  else return ".";
}
var init_resolve = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/resolve.ts"() {
    init_normalize_string();
    init_assert_path();
    init_env();
    init_util();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/relative.ts
function assertArgs2(from, to) {
  assertPath(from);
  assertPath(to);
  if (from === to) return "";
}
var init_relative = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/relative.ts"() {
    init_assert_path();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/relative.ts
function relative(from, to) {
  assertArgs2(from, to);
  from = resolve(from);
  to = resolve(to);
  if (from === to) return "";
  let fromStart = 1;
  const fromEnd = from.length;
  for (; fromStart < fromEnd; ++fromStart) {
    if (!isPosixPathSeparator(from.charCodeAt(fromStart))) break;
  }
  const fromLen = fromEnd - fromStart;
  let toStart = 1;
  const toEnd = to.length;
  for (; toStart < toEnd; ++toStart) {
    if (!isPosixPathSeparator(to.charCodeAt(toStart))) break;
  }
  const toLen = toEnd - toStart;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i <= length; ++i) {
    if (i === length) {
      if (toLen > length) {
        if (isPosixPathSeparator(to.charCodeAt(toStart + i))) {
          return to.slice(toStart + i + 1);
        } else if (i === 0) {
          return to.slice(toStart + i);
        }
      } else if (fromLen > length) {
        if (isPosixPathSeparator(from.charCodeAt(fromStart + i))) {
          lastCommonSep = i;
        } else if (i === 0) {
          lastCommonSep = 0;
        }
      }
      break;
    }
    const fromCode = from.charCodeAt(fromStart + i);
    const toCode = to.charCodeAt(toStart + i);
    if (fromCode !== toCode) break;
    else if (isPosixPathSeparator(fromCode)) lastCommonSep = i;
  }
  let out = "";
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || isPosixPathSeparator(from.charCodeAt(i))) {
      if (out.length === 0) out += "..";
      else out += "/..";
    }
  }
  if (out.length > 0) return out + to.slice(toStart + lastCommonSep);
  else {
    toStart += lastCommonSep;
    if (isPosixPathSeparator(to.charCodeAt(toStart))) ++toStart;
    return to.slice(toStart);
  }
}
var init_relative2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/relative.ts"() {
    init_util();
    init_resolve();
    init_relative();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/resolve.ts
function resolve2(...pathSegments) {
  let resolvedDevice = "";
  let resolvedTail = "";
  let resolvedAbsolute = false;
  for (let i = pathSegments.length - 1; i >= -1; i--) {
    let path;
    if (i >= 0) {
      path = pathSegments[i];
    } else if (!resolvedDevice) {
      path = cwd("Resolved a drive-letter-less path without a current working directory (CWD)");
    } else {
      path = cwd("Resolved a relative path without a current working directory (CWD)");
      if (path === void 0 || path.slice(0, 3).toLowerCase() !== `${resolvedDevice.toLowerCase()}\\`) {
        path = `${resolvedDevice}\\`;
      }
    }
    assertPath(path);
    const len = path.length;
    if (len === 0) continue;
    let rootEnd = 0;
    let device = "";
    let isAbsolute3 = false;
    const code = path.charCodeAt(0);
    if (len > 1) {
      if (isPathSeparator(code)) {
        isAbsolute3 = true;
        if (isPathSeparator(path.charCodeAt(1))) {
          let j = 2;
          let last = j;
          for (; j < len; ++j) {
            if (isPathSeparator(path.charCodeAt(j))) break;
          }
          if (j < len && j !== last) {
            const firstPart = path.slice(last, j);
            last = j;
            for (; j < len; ++j) {
              if (!isPathSeparator(path.charCodeAt(j))) break;
            }
            if (j < len && j !== last) {
              last = j;
              for (; j < len; ++j) {
                if (isPathSeparator(path.charCodeAt(j))) break;
              }
              if (j === len) {
                device = `\\\\${firstPart}\\${path.slice(last)}`;
                rootEnd = j;
              } else if (j !== last) {
                device = `\\\\${firstPart}\\${path.slice(last, j)}`;
                rootEnd = j;
              }
            }
          }
        } else {
          rootEnd = 1;
        }
      } else if (isWindowsDeviceRoot(code)) {
        if (path.charCodeAt(1) === CHAR_COLON) {
          device = path.slice(0, 2);
          rootEnd = 2;
          if (len > 2) {
            if (isPathSeparator(path.charCodeAt(2))) {
              isAbsolute3 = true;
              rootEnd = 3;
            }
          }
        }
      }
    } else if (isPathSeparator(code)) {
      rootEnd = 1;
      isAbsolute3 = true;
    }
    if (device.length > 0 && resolvedDevice.length > 0 && device.toLowerCase() !== resolvedDevice.toLowerCase()) {
      continue;
    }
    if (resolvedDevice.length === 0 && device.length > 0) {
      resolvedDevice = device;
    }
    if (!resolvedAbsolute) {
      resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`;
      resolvedAbsolute = isAbsolute3;
    }
    if (resolvedAbsolute && resolvedDevice.length > 0) break;
  }
  resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, "\\", isPathSeparator);
  return resolvedDevice + (resolvedAbsolute ? "\\" : "") + resolvedTail || ".";
}
var init_resolve2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/resolve.ts"() {
    init_constants();
    init_normalize_string();
    init_assert_path();
    init_env();
    init_util2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/relative.ts
function relative2(from, to) {
  assertArgs2(from, to);
  const fromOrig = resolve2(from);
  const toOrig = resolve2(to);
  if (fromOrig === toOrig) return "";
  from = fromOrig.toLowerCase();
  to = toOrig.toLowerCase();
  if (from === to) return "";
  let fromStart = 0;
  let fromEnd = from.length;
  for (; fromStart < fromEnd; ++fromStart) {
    if (from.charCodeAt(fromStart) !== CHAR_BACKWARD_SLASH) break;
  }
  for (; fromEnd - 1 > fromStart; --fromEnd) {
    if (from.charCodeAt(fromEnd - 1) !== CHAR_BACKWARD_SLASH) break;
  }
  const fromLen = fromEnd - fromStart;
  let toStart = 0;
  let toEnd = to.length;
  for (; toStart < toEnd; ++toStart) {
    if (to.charCodeAt(toStart) !== CHAR_BACKWARD_SLASH) break;
  }
  for (; toEnd - 1 > toStart; --toEnd) {
    if (to.charCodeAt(toEnd - 1) !== CHAR_BACKWARD_SLASH) break;
  }
  const toLen = toEnd - toStart;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i <= length; ++i) {
    if (i === length) {
      if (toLen > length) {
        if (to.charCodeAt(toStart + i) === CHAR_BACKWARD_SLASH) {
          return toOrig.slice(toStart + i + 1);
        } else if (i === 2) {
          return toOrig.slice(toStart + i);
        }
      }
      if (fromLen > length) {
        if (from.charCodeAt(fromStart + i) === CHAR_BACKWARD_SLASH) {
          lastCommonSep = i;
        } else if (i === 2) {
          lastCommonSep = 3;
        }
      }
      break;
    }
    const fromCode = from.charCodeAt(fromStart + i);
    const toCode = to.charCodeAt(toStart + i);
    if (fromCode !== toCode) break;
    else if (fromCode === CHAR_BACKWARD_SLASH) lastCommonSep = i;
  }
  if (i !== length && lastCommonSep === -1) {
    return toOrig;
  }
  let out = "";
  if (lastCommonSep === -1) lastCommonSep = 0;
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === CHAR_BACKWARD_SLASH) {
      if (out.length === 0) out += "..";
      else out += "\\..";
    }
  }
  if (out.length > 0) {
    return out + toOrig.slice(toStart + lastCommonSep, toEnd);
  } else {
    toStart += lastCommonSep;
    if (toOrig.charCodeAt(toStart) === CHAR_BACKWARD_SLASH) ++toStart;
    return toOrig.slice(toStart, toEnd);
  }
}
var init_relative3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/relative.ts"() {
    init_constants();
    init_resolve2();
    init_relative();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/relative.ts
function relative3(from, to) {
  return isWindows ? relative2(from, to) : relative(from, to);
}
var init_relative4 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/relative.ts"() {
    init_os2();
    init_relative2();
    init_relative3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/resolve.ts
var init_resolve3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/resolve.ts"() {
    init_os2();
    init_resolve();
    init_resolve2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/to_file_url.ts
var init_to_file_url = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/to_file_url.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/to_file_url.ts
var init_to_file_url2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/to_file_url.ts"() {
    init_to_file_url();
    init_is_absolute();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/to_file_url.ts
var init_to_file_url3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/to_file_url.ts"() {
    init_to_file_url();
    init_is_absolute2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/to_file_url.ts
var init_to_file_url4 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/to_file_url.ts"() {
    init_os2();
    init_to_file_url2();
    init_to_file_url3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/to_namespaced_path.ts
var init_to_namespaced_path = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/to_namespaced_path.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/to_namespaced_path.ts
var init_to_namespaced_path2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/to_namespaced_path.ts"() {
    init_constants();
    init_util2();
    init_resolve2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/to_namespaced_path.ts
var init_to_namespaced_path3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/to_namespaced_path.ts"() {
    init_os2();
    init_to_namespaced_path();
    init_to_namespaced_path2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/common.ts
var init_common = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/common.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/common.ts
var init_common2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/common.ts"() {
    init_common();
    init_constants2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/types.ts
var init_types = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/types.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/_common/glob_to_reg_exp.ts
var init_glob_to_reg_exp = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/_common/glob_to_reg_exp.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/glob_to_regexp.ts
var init_glob_to_regexp = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/glob_to_regexp.ts"() {
    init_glob_to_reg_exp();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/glob_to_regexp.ts
var init_glob_to_regexp2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/glob_to_regexp.ts"() {
    init_glob_to_reg_exp();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/glob_to_regexp.ts
var init_glob_to_regexp3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/glob_to_regexp.ts"() {
    init_os2();
    init_glob_to_regexp();
    init_glob_to_regexp2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/is_glob.ts
var init_is_glob = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/is_glob.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/constants.ts
var init_constants3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/constants.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/normalize_glob.ts
var init_normalize_glob = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/normalize_glob.ts"() {
    init_normalize2();
    init_constants3();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/posix/join_globs.ts
var init_join_globs = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/posix/join_globs.ts"() {
    init_join();
    init_constants3();
    init_normalize_glob();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/constants.ts
var init_constants4 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/constants.ts"() {
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/normalize_glob.ts
var init_normalize_glob2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/normalize_glob.ts"() {
    init_normalize3();
    init_constants4();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/windows/join_globs.ts
var init_join_globs2 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/windows/join_globs.ts"() {
    init_join2();
    init_constants4();
    init_normalize_glob2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/join_globs.ts
var init_join_globs3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/join_globs.ts"() {
    init_os2();
    init_join_globs();
    init_join_globs2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/normalize_glob.ts
var init_normalize_glob3 = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/normalize_glob.ts"() {
    init_os2();
    init_normalize_glob();
    init_normalize_glob2();
  }
});

// deno:https://jsr.io/@std/path/1.1.5/mod.ts
var init_mod = __esm({
  "deno:https://jsr.io/@std/path/1.1.5/mod.ts"() {
    init_basename4();
    init_constants2();
    init_dirname4();
    init_extname3();
    init_format4();
    init_from_file_url4();
    init_is_absolute3();
    init_join3();
    init_normalize4();
    init_parse3();
    init_relative4();
    init_resolve3();
    init_to_file_url4();
    init_to_namespaced_path3();
    init_common2();
    init_types();
    init_glob_to_regexp3();
    init_is_glob();
    init_join_globs3();
    init_normalize_glob3();
  }
});

// src/paths/layout.ts
function stripTrailingSlash(path) {
  return path.replace(/\/+$/, "");
}
function pickPath(env, envKey, devDefault, prodDefault, mode) {
  const override = env[envKey]?.trim();
  if (override) return stripTrailingSlash(override);
  return mode === "development" ? devDefault : prodDefault;
}
function pathExists(path) {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}
function hasDaemonCheckout(root) {
  return pathExists(join3(root, "orchestration", "ansible.cfg")) || pathExists(join3(root, "main.ts"));
}
function isCompiledStubRoot(root) {
  return root.includes("deno-compile") || root.startsWith("/tmp/") && !hasDaemonCheckout(root);
}
function readEnv(name) {
  try {
    return Deno.env.get(name) ?? void 0;
  } catch {
    return void 0;
  }
}
function detectInstallMode(env = {}, options = {}) {
  if (options.forceMode) return options.forceMode;
  const override = env.TURBOPANEL_DAEMON_ROOT?.trim();
  if (override && !isCompiledStubRoot(override) && hasDaemonCheckout(override)) {
    return "development";
  }
  const fromMeta = options.fromMeta ?? join3(dirname3(fromFileUrl3(import.meta.url)), "..", "..");
  if (!isCompiledStubRoot(fromMeta) && hasDaemonCheckout(fromMeta)) {
    return "development";
  }
  if (!options.skipDiscovery) {
    try {
      if (hasDaemonCheckout(Deno.cwd())) return "development";
    } catch {
    }
    if (hasDaemonCheckout(DEV_DAEMON_ROOT_DEFAULT)) return "development";
  }
  return "production";
}
function defaultDaemonRootForMode(mode) {
  return mode === "development" ? DEV_DAEMON_ROOT_DEFAULT : PROD_DAEMON_ROOT_DEFAULT;
}
function resolveLayout(env = {}, options = {}) {
  const mode = detectInstallMode(env, options);
  const home = pickPath(env, "TURBOPANEL_HOME", PROD_HOME_DEFAULT, PROD_HOME_DEFAULT, mode);
  const binDir = pickPath(env, "TURBOPANEL_BIN_DIR", join3(home, "bin"), PROD_BIN_DIR_DEFAULT, mode);
  const libDir = pickPath(env, "TURBOPANEL_LIB_DIR", join3(home, "lib"), PROD_LIB_DIR_DEFAULT, mode);
  const runtimeDir = pickPath(env, "TURBOPANEL_RUNTIME_DIR", DEV_RUNTIMES_DIR_DEFAULT, PROD_RUNTIME_DIR_DEFAULT, mode);
  const shareDir = pickPath(env, "TURBOPANEL_SHARE_DIR", join3(home, "share"), PROD_SHARE_DIR_DEFAULT, mode);
  const uiDir = pickPath(env, "TURBOPANEL_UI_DIR", join3(shareDir, "ui"), PROD_UI_DIR_DEFAULT, mode);
  const configDir = pickPath(env, "TURBOPANEL_CONFIG_DIR", DEV_CONFIG_DIR_DEFAULT, PROD_CONFIG_DIR_DEFAULT, mode);
  const stateDir = pickPath(env, "TURBOPANEL_STATE_DIR", DEV_DAEMON_STATE_DIR_DEFAULT, PROD_STATE_DIR_DEFAULT, mode);
  const logDir = pickPath(env, "TURBOPANEL_LOG_DIR", join3(home, "log"), PROD_LOG_DIR_DEFAULT, mode);
  const runDir = pickPath(env, "TURBOPANEL_RUN_DIR", PROD_RUN_DIR_DEFAULT, PROD_RUN_DIR_DEFAULT, mode);
  const daemonRootDefault = defaultDaemonRootForMode(mode);
  const orchestrationDir = (() => {
    const override = env.TURBOPANEL_ORCHESTRATION_DIR?.trim();
    if (override) return stripTrailingSlash(override);
    if (mode === "development") {
      const checkoutRoot = env.TURBOPANEL_DAEMON_ROOT?.trim() || options.fromMeta || (options.skipDiscovery ? void 0 : (() => {
        try {
          const fromMeta = join3(dirname3(fromFileUrl3(import.meta.url)), "..", "..");
          if (!isCompiledStubRoot(fromMeta) && hasDaemonCheckout(fromMeta)) {
            return fromMeta;
          }
          if (hasDaemonCheckout(Deno.cwd())) return Deno.cwd();
          if (hasDaemonCheckout(DEV_DAEMON_ROOT_DEFAULT)) {
            return DEV_DAEMON_ROOT_DEFAULT;
          }
        } catch {
        }
        return void 0;
      })());
      if (checkoutRoot) return join3(stripTrailingSlash(checkoutRoot), "orchestration");
      return join3(daemonRootDefault, "orchestration");
    }
    return PROD_ORCHESTRATION_DIR_DEFAULT;
  })();
  const runtimesDir = (() => {
    const override = env.TURBOPANEL_RUNTIMES_DIR?.trim();
    if (override) return stripTrailingSlash(override);
    return mode === "development" ? DEV_RUNTIMES_DIR_DEFAULT : runtimeDir;
  })();
  const instanceDir = pickPath(env, "TURBOPANEL_INSTANCE_DIR", DEV_INSTANCE_DIR_DEFAULT, PROD_INSTANCE_DIR_DEFAULT, mode);
  const instanceConfigDir = join3(configDir, "instance");
  const instanceCaPath = join3(configDir, "instance-ca.pem");
  const daemonStateDir = (() => {
    const override = env.TURBOPANEL_DAEMON_STATE_DIR?.trim();
    if (override) return stripTrailingSlash(override);
    return stateDir;
  })();
  return {
    mode,
    home,
    binDir,
    libDir,
    runtimeDir,
    shareDir,
    uiDir,
    orchestrationDir,
    configDir,
    stateDir,
    logDir,
    runDir,
    daemonRootDefault,
    runtimesDir,
    instanceDir,
    instanceConfigDir,
    instanceCaPath,
    daemonStateDir
  };
}
function resolveDaemonRoot(env = {}, options = {}) {
  const override = env.TURBOPANEL_DAEMON_ROOT?.trim();
  if (override) return override;
  const fromMeta = options.fromMeta ?? join3(dirname3(fromFileUrl3(import.meta.url)), "..", "..");
  if (!isCompiledStubRoot(fromMeta) && hasDaemonCheckout(fromMeta)) {
    return fromMeta;
  }
  if (!options.skipDiscovery) {
    try {
      const cwd2 = Deno.cwd();
      if (hasDaemonCheckout(cwd2)) return cwd2;
    } catch {
    }
  }
  const layout4 = resolveLayout(env, {
    ...options,
    fromMeta
  });
  const defaultRoot = layout4.daemonRootDefault;
  if (hasDaemonCheckout(defaultRoot)) return defaultRoot;
  if (isCompiledStubRoot(fromMeta)) return defaultRoot;
  return fromMeta;
}
var DEV_DAEMON_ROOT_DEFAULT, PROD_HOME_DEFAULT, PROD_BIN_DIR_DEFAULT, PROD_LIB_DIR_DEFAULT, PROD_RUNTIME_DIR_DEFAULT, PROD_SHARE_DIR_DEFAULT, PROD_UI_DIR_DEFAULT, PROD_CONFIG_DIR_DEFAULT, PROD_STATE_DIR_DEFAULT, PROD_LOG_DIR_DEFAULT, PROD_RUN_DIR_DEFAULT, PROD_DAEMON_ROOT_DEFAULT, PROD_ORCHESTRATION_DIR_DEFAULT, DEV_RUNTIMES_DIR_DEFAULT, DEV_CONFIG_DIR_DEFAULT, DEV_INSTANCE_DIR_DEFAULT, PROD_INSTANCE_DIR_DEFAULT, DEV_DAEMON_STATE_DIR_DEFAULT;
var init_layout = __esm({
  "src/paths/layout.ts"() {
    init_mod();
    DEV_DAEMON_ROOT_DEFAULT = "/opt/turbopanel/platform/daemon";
    PROD_HOME_DEFAULT = "/opt/turbopanel";
    PROD_BIN_DIR_DEFAULT = "/opt/turbopanel/bin";
    PROD_LIB_DIR_DEFAULT = "/opt/turbopanel/lib";
    PROD_RUNTIME_DIR_DEFAULT = "/opt/turbopanel/lib/runtime";
    PROD_SHARE_DIR_DEFAULT = "/opt/turbopanel/share";
    PROD_UI_DIR_DEFAULT = "/opt/turbopanel/share/ui";
    PROD_CONFIG_DIR_DEFAULT = "/etc/turbopanel";
    PROD_STATE_DIR_DEFAULT = "/var/lib/turbopanel";
    PROD_LOG_DIR_DEFAULT = "/var/log/turbopanel";
    PROD_RUN_DIR_DEFAULT = "/run/turbopanel";
    PROD_DAEMON_ROOT_DEFAULT = join3(PROD_LIB_DIR_DEFAULT, "daemon");
    PROD_ORCHESTRATION_DIR_DEFAULT = join3(PROD_SHARE_DIR_DEFAULT, "orchestration");
    DEV_RUNTIMES_DIR_DEFAULT = "/opt/turbopanel/runtimes";
    DEV_CONFIG_DIR_DEFAULT = "/opt/turbopanel/platform/config";
    DEV_INSTANCE_DIR_DEFAULT = "/opt/turbopanel/platform/instance";
    PROD_INSTANCE_DIR_DEFAULT = DEV_INSTANCE_DIR_DEFAULT;
    DEV_DAEMON_STATE_DIR_DEFAULT = join3(DEV_DAEMON_ROOT_DEFAULT, "state");
  }
});

// src/orchestration/paths.ts
function ansibleEnv() {
  return {
    ANSIBLE_CONFIG: ANSIBLE_CFG,
    ANSIBLE_LOCAL_TEMP: ANSIBLE_LOCAL_TMP,
    ANSIBLE_COLLECTIONS_PATH: GALAXY_COLLECTIONS_DIR
  };
}
function resolveUvTarget(os = Deno.build.os, arch = Deno.build.arch) {
  if (os !== "linux") {
    throw new Error(`Unsupported OS for orchestration runtime: "${os}". Only "linux" is supported.`);
  }
  let archPart;
  switch (arch) {
    case "aarch64":
      archPart = "aarch64";
      break;
    case "x86_64":
      archPart = "x86_64";
      break;
    default:
      throw new Error(`Unsupported CPU architecture for orchestration runtime: "${arch}". Only "aarch64" and "x86_64" are supported.`);
  }
  const triple = `${archPart}-unknown-linux-gnu`;
  return {
    triple,
    asset: `uv-${triple}.tar.gz`
  };
}
function uvDownloadUrl(asset, version = UV_VERSION) {
  return `https://github.com/astral-sh/uv/releases/download/${version}/${asset}`;
}
function cloudflaredDir(version = CLOUDFLARED_VERSION) {
  return join3(RUNTIMES_DIR, "cloudflared", version);
}
function cloudflaredBin(version = CLOUDFLARED_VERSION) {
  return join3(cloudflaredDir(version), "cloudflared");
}
function resolveCloudflaredAsset(arch = Deno.build.arch) {
  switch (arch) {
    case "aarch64":
      return "cloudflared-linux-arm64";
    case "x86_64":
      return "cloudflared-linux-amd64";
    default:
      throw new Error(`Unsupported CPU architecture for cloudflared: "${arch}". Only "aarch64" and "x86_64" are supported.`);
  }
}
function cloudflaredDownloadUrl(asset, version = CLOUDFLARED_VERSION) {
  return `https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset}`;
}
var UV_VERSION, PYTHON_VERSION, ANSIBLE_CORE_VERSION, layoutEnv, layout, DEFAULT_DAEMON_ROOT, DAEMON_ROOT, ORCHESTRATION_DIR, RUNTIMES_DIR, ANSIBLE_PLAYBOOK_CWD, UV_INSTALL_DIR, RUNTIME_BIN_DIR, UV_BIN, UVX_BIN, UV_CURRENT_DIR, PYTHON_INSTALL_DIR, CACHE_DIR, ANSIBLE_INSTALL_DIR, VENV_DIR, VENV_BIN_DIR, ANSIBLE_PLAYBOOK_BIN, ANSIBLE_CURRENT_DIR, REQUIREMENTS_FILE, GALAXY_REQUIREMENTS_FILE, GALAXY_ROLES_DIR, GALAXY_COLLECTIONS_DIR, ANSIBLE_LOCAL_TMP, ANSIBLE_CFG, LOCALHOST_PLAYBOOK, DAEMON_CONVERGE_PLAYBOOK, DOCKER_PLAYBOOK, POSTGRES_PLAYBOOK, REDIS_PLAYBOOK, RABBITMQ_PLAYBOOK, SOCKET_DIRS_PLAYBOOK, DAEMON_LOGS_PLAYBOOK, DAEMON_SYSTEMD_PLAYBOOK, BUILD_TOGGLE_PLAYBOOK, INSTANCE_CERTS_APPLY_PLAYBOOK, SET_HOSTNAME_PLAYBOOK, DAEMON_INSTALL_PLAYBOOK, CLOUDFLARED_VERSION, CLOUDFLARED_CURRENT_DIR, DENO_VERSION, DENO_RUNTIME_DIR, DENO_CURRENT_DIR, DENO_BIN, TUNNELS_DIR;
var init_paths = __esm({
  "src/orchestration/paths.ts"() {
    init_mod();
    init_layout();
    init_layout();
    UV_VERSION = "0.11.19";
    PYTHON_VERSION = "3.14";
    ANSIBLE_CORE_VERSION = "2.18";
    layoutEnv = {
      TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
      TURBOPANEL_RUNTIMES_DIR: readEnv("TURBOPANEL_RUNTIMES_DIR"),
      TURBOPANEL_RUNTIME_DIR: readEnv("TURBOPANEL_RUNTIME_DIR"),
      TURBOPANEL_ORCHESTRATION_DIR: readEnv("TURBOPANEL_ORCHESTRATION_DIR"),
      TURBOPANEL_HOME: readEnv("TURBOPANEL_HOME"),
      TURBOPANEL_LIB_DIR: readEnv("TURBOPANEL_LIB_DIR")
    };
    layout = resolveLayout(layoutEnv);
    DEFAULT_DAEMON_ROOT = layout.daemonRootDefault;
    DAEMON_ROOT = resolveDaemonRoot(layoutEnv);
    ORCHESTRATION_DIR = layout.orchestrationDir;
    RUNTIMES_DIR = layout.runtimesDir;
    ANSIBLE_PLAYBOOK_CWD = dirname3(RUNTIMES_DIR);
    UV_INSTALL_DIR = join3(RUNTIMES_DIR, "uv", UV_VERSION);
    RUNTIME_BIN_DIR = UV_INSTALL_DIR;
    UV_BIN = join3(RUNTIME_BIN_DIR, "uv");
    UVX_BIN = join3(RUNTIME_BIN_DIR, "uvx");
    UV_CURRENT_DIR = join3(RUNTIMES_DIR, "uv", "current");
    PYTHON_INSTALL_DIR = join3(RUNTIMES_DIR, "python");
    CACHE_DIR = join3(RUNTIMES_DIR, "uv", "cache");
    ANSIBLE_INSTALL_DIR = join3(RUNTIMES_DIR, "ansible", ANSIBLE_CORE_VERSION);
    VENV_DIR = ANSIBLE_INSTALL_DIR;
    VENV_BIN_DIR = join3(VENV_DIR, "bin");
    ANSIBLE_PLAYBOOK_BIN = join3(VENV_BIN_DIR, "ansible-playbook");
    ANSIBLE_CURRENT_DIR = join3(RUNTIMES_DIR, "ansible", "current");
    REQUIREMENTS_FILE = join3(ORCHESTRATION_DIR, "requirements.txt");
    GALAXY_REQUIREMENTS_FILE = join3(ORCHESTRATION_DIR, "requirements.yml");
    GALAXY_ROLES_DIR = join3(ORCHESTRATION_DIR, "roles");
    GALAXY_COLLECTIONS_DIR = join3(RUNTIMES_DIR, "ansible", "galaxy-collections");
    ANSIBLE_LOCAL_TMP = join3(CACHE_DIR, "ansible-tmp");
    ANSIBLE_CFG = join3(ORCHESTRATION_DIR, "ansible.cfg");
    LOCALHOST_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "localhost-test.yml");
    DAEMON_CONVERGE_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "daemon-converge.yml");
    DOCKER_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "docker-setup.yml");
    POSTGRES_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "postgres-setup.yml");
    REDIS_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "redis-setup.yml");
    RABBITMQ_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "rabbitmq-setup.yml");
    SOCKET_DIRS_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "socket-dirs-setup.yml");
    DAEMON_LOGS_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "daemon-logs-setup.yml");
    DAEMON_SYSTEMD_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "daemon-systemd-setup.yml");
    BUILD_TOGGLE_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "instance-build-toggle.yml");
    INSTANCE_CERTS_APPLY_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "instance-certs-apply.yml");
    SET_HOSTNAME_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "set-hostname.yml");
    DAEMON_INSTALL_PLAYBOOK = join3(ORCHESTRATION_DIR, "playbooks", "daemon-install.yml");
    CLOUDFLARED_VERSION = "2026.5.2";
    CLOUDFLARED_CURRENT_DIR = join3(RUNTIMES_DIR, "cloudflared", "current");
    DENO_VERSION = "2.9.0";
    DENO_RUNTIME_DIR = join3(RUNTIMES_DIR, "deno", DENO_VERSION);
    DENO_CURRENT_DIR = join3(RUNTIMES_DIR, "deno", "current");
    DENO_BIN = join3(DENO_CURRENT_DIR, "deno");
    TUNNELS_DIR = join3(DAEMON_ROOT, "cloudflared", "tunnels");
  }
});

// src/orchestration/exec.ts
function runtimeEnv(extra) {
  const path = `${RUNTIME_BIN_DIR}:${Deno.env.get("PATH") ?? ""}`;
  return {
    PATH: path,
    UV_PYTHON_INSTALL_DIR: PYTHON_INSTALL_DIR,
    // Managed Python lives under runtimes; skip ~/.local/bin shims (avoids PATH warning).
    UV_PYTHON_INSTALL_BIN: "0",
    UV_CACHE_DIR: CACHE_DIR,
    // Never touch shell profiles / global state; the runtime is self-contained.
    UV_NO_MODIFY_PATH: "1",
    // Allow uv to fetch managed pythons; explicit so behavior is obvious.
    UV_PYTHON_DOWNLOADS: "automatic",
    ...extra
  };
}
async function run(cmd, args, options = {}) {
  const { cwd: cwd2, env, stream = true } = options;
  const command = new Deno.Command(cmd, {
    args,
    cwd: cwd2,
    env: runtimeEnv(env),
    stdout: stream ? "inherit" : "piped",
    stderr: stream ? "inherit" : "piped"
  });
  const output = await command.output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    success: output.success,
    stdout: stream ? "" : decoder.decode(output.stdout),
    stderr: stream ? "" : decoder.decode(output.stderr)
  };
}
async function readStreamLines(stream, onLine) {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {
        stream: true
      });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) onLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) onLine(buffer);
  } finally {
    reader.releaseLock();
  }
}
async function runStreamingLines(cmd, args, options = {}) {
  const { cwd: cwd2, env, onStdoutLine, onStderrLine } = options;
  const command = new Deno.Command(cmd, {
    args,
    cwd: cwd2,
    env: runtimeEnv(env),
    stdout: "piped",
    stderr: onStderrLine ? "piped" : "inherit"
  });
  const child = command.spawn();
  const reads = [];
  if (child.stdout && onStdoutLine) {
    reads.push(readStreamLines(child.stdout, onStdoutLine));
  } else if (child.stdout) {
    reads.push(child.stdout.cancel());
  }
  if (child.stderr && onStderrLine) {
    reads.push(readStreamLines(child.stderr, onStderrLine));
  }
  await Promise.all(reads);
  const status = await child.status;
  return {
    code: status.code,
    success: status.success
  };
}
async function runLogged(cmd, args, options) {
  const { cwd: cwd2, env, level, component, stderrLevel = level } = options;
  const result = await runStreamingLines(cmd, args, {
    cwd: cwd2,
    env,
    onStdoutLine: (line) => log(level, component, line),
    onStderrLine: (line) => log(stderrLevel, component, line)
  });
  if (!result.success) {
    throw new Error(`Command failed (exit ${result.code}): ${cmd} ${args.join(" ")}`);
  }
  return result;
}
async function runOrThrow(cmd, args, options = {}) {
  const result = await run(cmd, args, options);
  if (!result.success) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`Command failed (exit ${result.code}): ${cmd} ${args.join(" ")}` + (detail ? `
${detail}` : ""));
  }
  return result;
}
var init_exec = __esm({
  "src/orchestration/exec.ts"() {
    init_logger();
    init_paths();
  }
});

// src/orchestration/ansible-events.ts
function parseAnsibleJsonlLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed;
    if (typeof record._event !== "string" || typeof record._timestamp !== "string") {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}
function formatPlaybookRecap(stats) {
  let ok = 0;
  let changed = 0;
  let failed = 0;
  let unreachable = 0;
  for (const hostStats of Object.values(stats)) {
    ok += hostStats.ok ?? 0;
    changed += hostStats.changed ?? 0;
    failed += hostStats.failed ?? 0;
    unreachable += hostStats.unreachable ?? 0;
  }
  return `ok=${ok} changed=${changed} failed=${failed} unreachable=${unreachable}`;
}
function sanitizeAnsibleSummaryText(text) {
  const stripped = text.replaceAll("\n", " ").replaceAll("\r", " ").replaceAll("	", " ").replace(/[\u0000-\u001f\u007f]/g, "");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed.length > ANSIBLE_SUMMARY_MAX_LENGTH ? collapsed.slice(0, ANSIBLE_SUMMARY_MAX_LENGTH) : collapsed;
}
function logAnsibleEvent(event) {
  switch (event._event) {
    case "v2_playbook_on_play_start": {
      const playEvent = event;
      logInfo("ansible", "[play] " + playEvent.play.name);
      break;
    }
    case "v2_playbook_on_task_start": {
      const taskEvent = event;
      logDebug("ansible", "[task] " + taskEvent.task.name);
      break;
    }
    case "v2_runner_on_ok": {
      const okEvent = event;
      const anyChanged = Object.values(okEvent.hosts).some((host) => host.changed === true);
      if (anyChanged) {
        logInfo("ansible", "[changed] " + okEvent.task.name);
      } else {
        logDebug("ansible", "[ok] " + okEvent.task.name);
      }
      break;
    }
    case "v2_runner_on_skipped": {
      const skippedEvent = event;
      logDebug("ansible", "[skipped] " + skippedEvent.task.name);
      break;
    }
    case "v2_runner_on_failed":
    case "v2_runner_on_unreachable": {
      const failedEvent = event;
      const firstHost = Object.values(failedEvent.hosts)[0];
      const firstMsg = firstHost?.msg ?? "unknown error";
      logError("ansible", "[failed] " + failedEvent.task.name + ": " + firstMsg);
      break;
    }
    case "v2_playbook_on_stats": {
      const statsEvent = event;
      logInfo("ansible", "[recap] " + formatPlaybookRecap(statsEvent.stats));
      break;
    }
  }
}
async function runPlaybookStreaming(ansiblePlaybookBin, args, options) {
  const quiet = options.quiet === true;
  const result = await runStreamingLines(ansiblePlaybookBin, args, {
    cwd: options.cwd,
    env: options.env,
    onStdoutLine: (line) => {
      const event = parseAnsibleJsonlLine(line);
      if (event) {
        if (!quiet) logAnsibleEvent(event);
        if (options.onEvent) options.onEvent(event);
      } else if (!quiet && line.trim().length > 0) {
        logInfo("ansible", line);
      }
    },
    onStderrLine: (line) => {
      if (!quiet && line.trim().length > 0) logInfo("ansible", line);
    }
  });
  if (!result.success) {
    throw new Error(`ansible-playbook failed (exit ${result.code}): ${ansiblePlaybookBin} ${args.join(" ")}`);
  }
}
var ANSIBLE_SUMMARY_MAX_LENGTH, AnsibleRunSummaryCollector;
var init_ansible_events = __esm({
  "src/orchestration/ansible-events.ts"() {
    init_logger();
    init_exec();
    ANSIBLE_SUMMARY_MAX_LENGTH = 500;
    AnsibleRunSummaryCollector = class {
      #recap = null;
      #firstFailure = null;
      handleEvent(event) {
        switch (event._event) {
          case "v2_playbook_on_stats": {
            const statsEvent = event;
            this.#recap = formatPlaybookRecap(statsEvent.stats);
            break;
          }
          case "v2_runner_on_failed":
          case "v2_runner_on_unreachable": {
            if (this.#firstFailure) break;
            const failedEvent = event;
            const firstHost = Object.values(failedEvent.hosts)[0];
            const msg = typeof firstHost?.msg === "string" ? firstHost.msg : "unknown error";
            const taskName = failedEvent.task.name ?? "task";
            this.#firstFailure = `${taskName}: ${msg}`;
            break;
          }
        }
      }
      build() {
        const parts = [];
        if (this.#recap) parts.push(this.#recap);
        if (this.#firstFailure) parts.push(this.#firstFailure);
        return sanitizeAnsibleSummaryText(parts.join("; "));
      }
    };
  }
});

// deno:https://jsr.io/@std/encoding/1.0.10/_common16.ts
function calcSizeHex(originalSize) {
  return originalSize * 2;
}
function encode(buffer, i, o, alphabet6) {
  for (; i < buffer.length; ++i) {
    const x = buffer[i];
    buffer[o++] = alphabet6[x >> 4];
    buffer[o++] = alphabet6[x & 15];
  }
  return o;
}
var alphabet, rAlphabet;
var init_common16 = __esm({
  "deno:https://jsr.io/@std/encoding/1.0.10/_common16.ts"() {
    alphabet = new TextEncoder().encode("0123456789abcdef");
    rAlphabet = new Uint8Array(128).fill(16);
    alphabet.forEach((byte, i) => rAlphabet[byte] = i);
    new TextEncoder().encode("ABCDEF").forEach((byte, i) => rAlphabet[byte] = i + 10);
  }
});

// deno:https://jsr.io/@std/encoding/1.0.10/_common_detach.ts
function detach(buffer, maxSize) {
  const originalSize = buffer.length;
  if (buffer.byteOffset) {
    const b = new Uint8Array(buffer.buffer);
    b.set(buffer);
    buffer = b.subarray(0, originalSize);
  }
  buffer = new Uint8Array(buffer.buffer.transfer(maxSize));
  buffer.set(buffer.subarray(0, originalSize), maxSize - originalSize);
  return [
    buffer,
    maxSize - originalSize
  ];
}
var init_common_detach = __esm({
  "deno:https://jsr.io/@std/encoding/1.0.10/_common_detach.ts"() {
  }
});

// deno:https://jsr.io/@std/encoding/1.0.10/hex.ts
function encodeHex(src) {
  if (typeof src === "string") {
    src = new TextEncoder().encode(src);
  } else if (src instanceof ArrayBuffer) src = new Uint8Array(src).slice();
  else src = src.slice();
  const [output, i] = detach(src, calcSizeHex(src.length));
  encode(output, i, 0, alphabet2);
  return new TextDecoder().decode(output);
}
var alphabet2, rAlphabet2;
var init_hex = __esm({
  "deno:https://jsr.io/@std/encoding/1.0.10/hex.ts"() {
    init_common16();
    init_common_detach();
    alphabet2 = new TextEncoder().encode("0123456789abcdef");
    rAlphabet2 = new Uint8Array(128).fill(16);
    alphabet2.forEach((byte, i) => rAlphabet2[byte] = i);
    new TextEncoder().encode("ABCDEF").forEach((byte, i) => rAlphabet2[byte] = i + 10);
  }
});

// src/orchestration/bootstrap-stamp.ts
async function fileExists(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
async function computeBootstrapStamp() {
  const [reqTxt, reqYml] = await Promise.all([
    Deno.readTextFile(REQUIREMENTS_FILE),
    Deno.readTextFile(GALAXY_REQUIREMENTS_FILE)
  ]);
  const material = `${UV_VERSION}
${PYTHON_VERSION}
${reqTxt}
${reqYml}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return encodeHex(new Uint8Array(digest));
}
async function readBootstrapStamp() {
  if (!await fileExists(BOOTSTRAP_STAMP_FILE)) return null;
  const text = await Deno.readTextFile(BOOTSTRAP_STAMP_FILE);
  const stamp = text.trim();
  return stamp.length > 0 ? stamp : null;
}
async function writeBootstrapStamp(stamp) {
  await Deno.mkdir(join3(RUNTIMES_DIR, "ansible"), {
    recursive: true
  });
  await Deno.writeTextFile(BOOTSTRAP_STAMP_FILE, `${stamp}
`);
}
async function galaxyContentPresent() {
  const dockerRole = join3(GALAXY_ROLES_DIR, "geerlingguy.docker");
  const posixCollection = join3(GALAXY_COLLECTIONS_DIR, "ansible_collections", "ansible", "posix");
  return await fileExists(dockerRole) && await fileExists(posixCollection);
}
var BOOTSTRAP_STAMP_FILE;
var init_bootstrap_stamp = __esm({
  "src/orchestration/bootstrap-stamp.ts"() {
    init_hex();
    init_mod();
    init_paths();
    BOOTSTRAP_STAMP_FILE = join3(RUNTIMES_DIR, "ansible", "bootstrap.stamp");
  }
});

// src/orchestration/dev-orchestration.ts
async function fileExists2(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
function resolveDevOrchestrationDir() {
  const override = Deno.env.get("TURBOPANEL_DEV_ORCHESTRATION_DIR")?.trim();
  return override && override.length > 0 ? override : DEFAULT_DEV_ORCHESTRATION_DIR;
}
async function readDevConvergeManifest(root = resolveDevOrchestrationDir()) {
  const manifestPath = join3(root, DEV_CONVERGE_MANIFEST_FILE);
  const raw = await Deno.readTextFile(manifestPath);
  const parsed = JSON.parse(raw);
  if (typeof parsed.playbook !== "string" || !Array.isArray(parsed.roles) || !Array.isArray(parsed.devRoles)) {
    throw new Error(`Invalid dev converge manifest at ${manifestPath}`);
  }
  return parsed;
}
async function resolveDevOrchestrationLayout() {
  const root = resolveDevOrchestrationDir();
  const manifest = await readDevConvergeManifest(root);
  return {
    root,
    manifest,
    playbookPath: join3(root, manifest.playbook),
    ansibleCfgPath: join3(root, "ansible.cfg"),
    devRolesDir: join3(root, "roles"),
    daemonRolesDir: GALAXY_ROLES_DIR
  };
}
function resolveDevConvergeRoleDir(layout4, roleName) {
  if (layout4.manifest.devRoles.includes(roleName)) {
    return join3(layout4.devRolesDir, roleName);
  }
  return join3(layout4.daemonRolesDir, roleName);
}
function devOrchestrationAnsibleEnv(layout4) {
  return {
    ANSIBLE_CONFIG: layout4.ansibleCfgPath,
    ANSIBLE_LOCAL_TEMP: join3(RUNTIMES_DIR, "uv", "cache", "ansible-tmp"),
    ANSIBLE_COLLECTIONS_PATH: GALAXY_COLLECTIONS_DIR
  };
}
async function requireDevOrchestrationLayout() {
  const layout4 = await resolveDevOrchestrationLayout();
  if (!await fileExists2(layout4.playbookPath)) {
    throw new Error(`Dev orchestration playbook missing at ${layout4.playbookPath} \u2014 stage turbopanel-dev orchestration before converge`);
  }
  if (!await fileExists2(layout4.ansibleCfgPath)) {
    throw new Error(`Dev orchestration ansible.cfg missing at ${layout4.ansibleCfgPath}`);
  }
  return layout4;
}
var DEFAULT_DEV_ORCHESTRATION_DIR, DEV_CONVERGE_MANIFEST_FILE;
var init_dev_orchestration = __esm({
  "src/orchestration/dev-orchestration.ts"() {
    init_mod();
    init_paths();
    DEFAULT_DEV_ORCHESTRATION_DIR = "/opt/turbopanel/dev-orchestration";
    DEV_CONVERGE_MANIFEST_FILE = "dev-converge-manifest.json";
  }
});

// src/orchestration/converge-stamp.ts
function forceConvergeRequested() {
  const flag = Deno.env.get("TURBOPANEL_FORCE_CONVERGE")?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}
async function fileExists3(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
async function digestText(material) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return encodeHex(new Uint8Array(digest));
}
async function collectRoleYamlMaterial(layout4, roleName) {
  const roleDir = resolveDevConvergeRoleDir(layout4, roleName);
  const collected = [];
  async function walk(dir) {
    let entries = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry);
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
    for (const entry of entries) {
      const path = join3(dir, entry.name);
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml") && !entry.name.endsWith(".j2")) {
        continue;
      }
      const rel = relative3(roleDir, path);
      const body = await Deno.readTextFile(path);
      collected.push(`${roleName}/${rel}
${body}`);
    }
  }
  await walk(roleDir);
  collected.sort();
  return collected;
}
function devConvergeEnvMaterial() {
  const devUser = Deno.env.get("TURBOPANEL_DEV_USER")?.trim() ?? "";
  const devUid = Deno.env.get("TURBOPANEL_DEV_UID")?.trim() ?? "";
  const devGid = Deno.env.get("TURBOPANEL_DEV_GID")?.trim() ?? "";
  const uiMode = Deno.env.get("TURBOPANEL_UI_MODE") === "static" ? "static" : "dev";
  const instanceRunMode = Deno.env.get("TURBOPANEL_INSTANCE_RUN_MODE") === "compiled" ? "compiled" : "source";
  const instanceRuntime = Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME") === "workers" ? "workers" : "deno";
  return [
    `dev_user=${devUser}`,
    `dev_uid=${devUid}`,
    `dev_gid=${devGid}`,
    `ui_mode=${uiMode}`,
    `instance_run_mode=${instanceRunMode}`,
    `instance_runtime=${instanceRuntime}`
  ].join("\n");
}
async function computeDevConvergeStamp() {
  const layout4 = await resolveDevOrchestrationLayout();
  const playbook = await Deno.readTextFile(layout4.playbookPath);
  const roleChunks = [];
  for (const roleName of layout4.manifest.roles) {
    roleChunks.push(...await collectRoleYamlMaterial(layout4, roleName));
  }
  const material = [
    layout4.root,
    playbook,
    devConvergeEnvMaterial(),
    ...roleChunks
  ].join("\n---\n");
  return await digestText(material);
}
async function readDevConvergeStamp() {
  if (!await fileExists3(DEV_CONVERGE_STAMP_FILE)) return null;
  const text = await Deno.readTextFile(DEV_CONVERGE_STAMP_FILE);
  const stamp = text.trim();
  return stamp.length > 0 ? stamp : null;
}
async function writeDevConvergeStamp(stamp) {
  await Deno.mkdir(join3(RUNTIMES_DIR, "ansible"), {
    recursive: true
  });
  await Deno.writeTextFile(DEV_CONVERGE_STAMP_FILE, `${stamp}
`);
}
async function shouldSkipDevConverge(instanceServiceEnabled) {
  if (forceConvergeRequested()) return false;
  if (!instanceServiceEnabled) return false;
  const stored = await readDevConvergeStamp();
  if (!stored) return false;
  const current = await computeDevConvergeStamp();
  return stored === current;
}
async function describeDevConvergeDecision(instanceServiceEnabled) {
  if (forceConvergeRequested()) {
    return "TURBOPANEL_FORCE_CONVERGE is set";
  }
  if (!instanceServiceEnabled) {
    return "turbopanel-instance.service is not enabled";
  }
  const stored = await readDevConvergeStamp();
  if (!stored) {
    return "no dev converge stamp (first converge or stamp missing)";
  }
  const current = await computeDevConvergeStamp();
  if (stored === current) {
    return "dev converge stamp matches (orchestration inputs unchanged)";
  }
  return "dev converge stamp mismatch (orchestration, roles, or dev env changed)";
}
var DEV_CONVERGE_STAMP_FILE;
var init_converge_stamp = __esm({
  "src/orchestration/converge-stamp.ts"() {
    init_hex();
    init_mod();
    init_dev_orchestration();
    init_paths();
    DEV_CONVERGE_STAMP_FILE = join3(RUNTIMES_DIR, "ansible", "dev-converge.stamp");
  }
});

// src/orchestration/ansible.ts
var ansible_exports = {};
__export(ansible_exports, {
  ansiblePlaybookWorks: () => ansiblePlaybookWorks,
  bootstrapOrchestrationRuntime: () => bootstrapOrchestrationRuntime,
  devOwnershipPlaybookExtraArgs: () => devOwnershipPlaybookExtraArgs,
  ensureAnsible: () => ensureAnsible,
  ensureGalaxyRoles: () => ensureGalaxyRoles,
  runBuildToggle: () => runBuildToggle,
  runDaemonConverge: () => runDaemonConverge,
  runDaemonLogsSetup: () => runDaemonLogsSetup,
  runDaemonSystemdSetup: () => runDaemonSystemdSetup,
  runDockerSetup: () => runDockerSetup,
  runInstanceDevInstall: () => runInstanceDevInstall,
  runLocalPlaybook: () => runLocalPlaybook,
  runLocalhostTest: () => runLocalhostTest,
  runPostgresSetup: () => runPostgresSetup,
  runRabbitmqSetup: () => runRabbitmqSetup,
  runRedisSetup: () => runRedisSetup,
  runSetHostname: () => runSetHostname,
  runSocketDirsSetup: () => runSocketDirsSetup
});
async function fileExists4(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
async function ansiblePlaybookWorks() {
  if (!await fileExists4(ANSIBLE_PLAYBOOK_BIN)) return false;
  const result = await run(ANSIBLE_PLAYBOOK_BIN, [
    "--version"
  ], {
    stream: false
  });
  return result.success;
}
async function repointAnsibleCurrent() {
  try {
    await Deno.remove(ANSIBLE_CURRENT_DIR);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn("orchestration", "could not replace ansible current symlink:", err);
      return;
    }
  }
  try {
    await Deno.symlink(ANSIBLE_INSTALL_DIR, ANSIBLE_CURRENT_DIR, {
      type: "dir"
    });
  } catch (err) {
    logWarn("orchestration", "could not create ansible current symlink:", err);
  }
}
async function runLocalPlaybook(playbook, extraArgs = [], onEvent, env = ansibleEnv(), quiet = false) {
  const args = [
    "-i",
    "localhost,",
    "-c",
    "local",
    ...extraArgs,
    playbook
  ];
  await runPlaybookStreaming(ANSIBLE_PLAYBOOK_BIN, args, {
    cwd: ANSIBLE_PLAYBOOK_CWD,
    env,
    onEvent,
    quiet
  });
}
function devOwnershipPlaybookExtraArgs(env = Deno.env.toObject()) {
  const args = [];
  const devUser = env.TURBOPANEL_DEV_USER;
  const devUid = env.TURBOPANEL_DEV_UID;
  const devGid = env.TURBOPANEL_DEV_GID;
  if (devUser) args.push("-e", `turbopanel_dev_user=${devUser}`);
  if (devUid) args.push("-e", `turbopanel_dev_uid=${devUid}`);
  if (devGid) args.push("-e", `turbopanel_dev_gid=${devGid}`);
  return args;
}
function devInstanceExtraArgs() {
  const uiMode = Deno.env.get("TURBOPANEL_UI_MODE") === "static" ? "static" : "dev";
  const instanceRunMode = Deno.env.get("TURBOPANEL_INSTANCE_RUN_MODE") === "compiled" ? "compiled" : "source";
  const instanceRuntime = Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME") === "workers" ? "workers" : "deno";
  const args = [
    ...devOwnershipPlaybookExtraArgs()
  ];
  args.push("-e", `turbopanel_ui_mode=${uiMode}`);
  args.push("-e", `turbopanel_instance_run_mode=${instanceRunMode}`);
  args.push("-e", `turbopanel_instance_runtime=${instanceRuntime}`);
  if (instanceRuntime === "workers") {
    args.push("-e", "postgres_expose_port=true");
  }
  const publicUrls = Deno.env.get("TURBOPANEL_PUBLIC_URLS");
  if (publicUrls) {
    args.push("-e", `turbopanel_public_urls=${publicUrls}`);
  }
  return args;
}
async function ensureAnsible() {
  if (await ansiblePlaybookWorks()) {
    logInfo("orchestration", "ansible already installed, skipping setup");
    await repointAnsibleCurrent();
    return;
  }
  logInfo("orchestration", `creating venv at ${VENV_DIR}`);
  await runOrThrow(UV_BIN, [
    "venv",
    "--python",
    PYTHON_VERSION,
    VENV_DIR
  ]);
  logInfo("orchestration", `installing packages from ${REQUIREMENTS_FILE}`);
  await runOrThrow(UV_BIN, [
    "pip",
    "install",
    "--python",
    VENV_DIR,
    "--requirements",
    REQUIREMENTS_FILE
  ]);
  if (!await ansiblePlaybookWorks()) {
    throw new Error("ansible install verification failed: ansible-playbook not runnable");
  }
  await repointAnsibleCurrent();
  logInfo("orchestration", "ansible installed");
}
async function ensureGalaxyRoles() {
  if (!await ansiblePlaybookWorks()) {
    throw new Error("ansible-galaxy requires a working ansible-playbook install");
  }
  const stamp = await computeBootstrapStamp();
  const storedStamp = await readBootstrapStamp();
  if (storedStamp === stamp && await galaxyContentPresent()) {
    logInfo("orchestration", "galaxy content up to date, skipping install");
    return;
  }
  const galaxyBin = join3(VENV_BIN_DIR, "ansible-galaxy");
  logInfo("orchestration", `installing galaxy roles from ${GALAXY_REQUIREMENTS_FILE}`);
  await runLogged(galaxyBin, [
    "role",
    "install",
    "-r",
    GALAXY_REQUIREMENTS_FILE,
    "-p",
    GALAXY_ROLES_DIR
  ], {
    level: "INFO",
    component: "ansible-galaxy"
  });
  logInfo("orchestration", "galaxy roles ready");
  logInfo("orchestration", `installing galaxy collections from ${GALAXY_REQUIREMENTS_FILE}`);
  await runLogged(galaxyBin, [
    "collection",
    "install",
    "-r",
    GALAXY_REQUIREMENTS_FILE,
    "-p",
    GALAXY_COLLECTIONS_DIR
  ], {
    level: "INFO",
    component: "ansible-galaxy"
  });
  logInfo("orchestration", "galaxy collections ready");
}
async function runLocalhostTest(onEvent) {
  logInfo("orchestration", "running localhost smoke-test playbook");
  await runLocalPlaybook(LOCALHOST_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "localhost smoke-test passed");
}
async function runDaemonConverge(onEvent) {
  const args = devInstanceExtraArgs();
  logInfo("orchestration", "running daemon-converge playbook");
  await runLocalPlaybook(DAEMON_CONVERGE_PLAYBOOK, args, onEvent);
  logInfo("orchestration", "daemon-converge complete");
}
async function runSocketDirsSetup(onEvent) {
  logInfo("orchestration", "running socket-dirs-setup playbook");
  await runLocalPlaybook(SOCKET_DIRS_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "socket-dirs-setup complete");
}
async function runSetHostname(hostname, onEvent) {
  logInfo("orchestration", "running set-hostname playbook");
  const collector = new AnsibleRunSummaryCollector();
  const eventHandler = (event) => {
    collector.handleEvent(event);
    onEvent?.(event);
  };
  try {
    await runLocalPlaybook(SET_HOSTNAME_PLAYBOOK, [
      "-e",
      `turbopanel_hostname=${hostname}`
    ], eventHandler);
  } catch {
    const summary = collector.build();
    throw new Error(summary.length > 0 ? `set-hostname playbook failed: ${summary}` : "set-hostname playbook failed");
  }
  logInfo("orchestration", "set-hostname complete");
  return {
    summary: collector.build()
  };
}
async function runDaemonLogsSetup(onEvent) {
  logInfo("orchestration", "running daemon-logs-setup playbook");
  await runLocalPlaybook(DAEMON_LOGS_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "daemon-logs-setup complete");
}
async function coLocatedInstanceServiceEnabled() {
  try {
    const result = await run("systemctl", [
      "is-enabled",
      "turbopanel-instance"
    ], {
      stream: false
    });
    return result.success;
  } catch {
    return false;
  }
}
async function runDaemonSystemdSetup(onEvent) {
  const afterInstance = await coLocatedInstanceServiceEnabled();
  logInfo("orchestration", `running daemon-systemd-setup playbook (after_instance=${afterInstance})`);
  const args = [
    "-i",
    "localhost,",
    "-c",
    "local",
    "-e",
    `turbopanel_after_instance_service=${afterInstance}`,
    DAEMON_SYSTEMD_PLAYBOOK
  ];
  const cwd2 = ORCHESTRATION_DIR;
  await runPlaybookStreaming(ANSIBLE_PLAYBOOK_BIN, args, {
    cwd: cwd2,
    env: ansibleEnv(),
    onEvent
  });
  logInfo("orchestration", "daemon-systemd-setup complete");
}
async function runInstanceDevInstall(onEvent) {
  const instanceEnabled = await coLocatedInstanceServiceEnabled();
  const convergeReason = await describeDevConvergeDecision(instanceEnabled);
  if (await shouldSkipDevConverge(instanceEnabled)) {
    logInfo("orchestration", `skipping instance-dev-install: ${convergeReason}`);
    return;
  }
  const layout4 = await requireDevOrchestrationLayout();
  const args = devInstanceExtraArgs();
  logInfo("orchestration", `running instance-dev-install converge playbook (${layout4.playbookPath}): ${convergeReason}`);
  await runLocalPlaybook(layout4.playbookPath, args, onEvent, devOrchestrationAnsibleEnv(layout4));
  await writeDevConvergeStamp(await computeDevConvergeStamp());
  logInfo("orchestration", "instance-dev-install complete");
}
async function runBuildToggle(opts, onEvent) {
  const instanceRuntime = Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME") === "workers" ? "workers" : "deno";
  const args = [
    "-e",
    `turbopanel_ui_mode=${opts.uiMode}`,
    "-e",
    `turbopanel_instance_run_mode=${opts.instanceRunMode}`,
    "-e",
    `turbopanel_instance_runtime=${instanceRuntime}`,
    "-e",
    `force_build=${opts.forceBuild ?? false}`,
    "-e",
    `force_compile=${opts.forceBuild ?? false}`
  ];
  logInfo("orchestration", `running instance-build-toggle playbook (ui=${opts.uiMode}, instance=${opts.instanceRunMode})`);
  await runLocalPlaybook(BUILD_TOGGLE_PLAYBOOK, args, onEvent);
  logInfo("orchestration", "instance-build-toggle complete");
}
async function runDockerSetup(onEvent) {
  logInfo("orchestration", "running docker-setup playbook");
  await runLocalPlaybook(DOCKER_PLAYBOOK, devInstanceExtraArgs(), onEvent);
  logInfo("orchestration", "docker-setup complete");
}
async function runPostgresSetup(onEvent) {
  logInfo("orchestration", "running postgres-setup playbook");
  await runLocalPlaybook(POSTGRES_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "postgres-setup complete");
}
async function runRedisSetup(onEvent) {
  logInfo("orchestration", "running redis-setup playbook");
  await runLocalPlaybook(REDIS_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "redis-setup complete");
}
async function runRabbitmqSetup(onEvent) {
  logInfo("orchestration", "running rabbitmq-setup playbook");
  await runLocalPlaybook(RABBITMQ_PLAYBOOK, [], onEvent);
  logInfo("orchestration", "rabbitmq-setup complete");
}
async function bootstrapOrchestrationRuntime() {
  const stamp = await computeBootstrapStamp();
  const previousStamp = await readBootstrapStamp();
  const bootstrapInputsChanged = previousStamp !== stamp;
  const ansibleWasReady = await ansiblePlaybookWorks();
  await ensureAnsible();
  const ansibleReinstalled = !ansibleWasReady;
  await ensureGalaxyRoles();
  if (bootstrapInputsChanged || ansibleReinstalled) {
    await runLocalhostTest();
  } else {
    logInfo("orchestration", "bootstrap inputs unchanged, skipping localhost smoke-test");
  }
  await writeBootstrapStamp(stamp);
}
var init_ansible = __esm({
  "src/orchestration/ansible.ts"() {
    init_exec();
    init_ansible_events();
    init_bootstrap_stamp();
    init_converge_stamp();
    init_mod();
    init_logger();
    init_dev_orchestration();
    init_paths();
  }
});

// src/orchestration/bundle-extract.ts
async function fileExists5(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
async function ensureOrchestrationTree() {
  const ansibleCfg = join3(ORCHESTRATION_DIR, "ansible.cfg");
  if (await fileExists5(ansibleCfg)) return;
  const mode = detectInstallMode({
    TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT"),
    TURBOPANEL_ORCHESTRATION_DIR: readEnv("TURBOPANEL_ORCHESTRATION_DIR")
  });
  if (mode === "development") {
    throw new Error(`orchestration tree missing at ${ORCHESTRATION_DIR} (dev checkout should include orchestration/)`);
  }
  const layout4 = resolveLayout({
    TURBOPANEL_ORCHESTRATION_DIR: readEnv("TURBOPANEL_ORCHESTRATION_DIR")
  }, {
    forceMode: "production"
  });
  throw new Error(`orchestration tree missing at ${layout4.orchestrationDir} (release install must ship share/orchestration)`);
}
var init_bundle_extract = __esm({
  "src/orchestration/bundle-extract.ts"() {
    init_mod();
    init_layout();
    init_paths();
  }
});

// src/orchestration/python.ts
async function ensurePython() {
  await Deno.mkdir(PYTHON_INSTALL_DIR, {
    recursive: true
  });
  logInfo("orchestration", `ensuring Python ${PYTHON_VERSION} is installed`);
  await runLogged(UV_BIN, [
    "python",
    "install",
    "--no-bin",
    PYTHON_VERSION
  ], {
    level: "DEBUG",
    component: "python"
  });
  logInfo("orchestration", `Python ${PYTHON_VERSION} ready`);
}
var init_python = __esm({
  "src/orchestration/python.ts"() {
    init_exec();
    init_logger();
    init_paths();
  }
});

// src/orchestration/uv.ts
async function fileExists6(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
async function installedUvVersion() {
  if (!await fileExists6(UV_BIN)) return null;
  try {
    const result = await run(UV_BIN, [
      "--version"
    ], {
      stream: false
    });
    if (!result.success) return null;
    const match = result.stdout.trim().match(/uv\s+(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
async function sha256Hex(bytes) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return encodeHex(new Uint8Array(digest));
}
async function repointUvCurrent() {
  try {
    await Deno.remove(UV_CURRENT_DIR);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn("orchestration", "could not replace uv current symlink:", err);
      return;
    }
  }
  try {
    await Deno.mkdir(join3(RUNTIMES_DIR, "uv"), {
      recursive: true
    });
    await Deno.symlink(RUNTIME_BIN_DIR, UV_CURRENT_DIR, {
      type: "dir"
    });
  } catch (err) {
    logWarn("orchestration", "could not create uv current symlink:", err);
  }
}
async function ensureUv() {
  const current = await installedUvVersion();
  if (current === UV_VERSION) {
    logInfo("orchestration", `uv ${UV_VERSION} already installed`);
    await repointUvCurrent();
    return;
  }
  if (current) {
    logInfo("orchestration", `uv ${current} found, replacing with pinned ${UV_VERSION}`);
  }
  const { asset } = resolveUvTarget();
  const url = uvDownloadUrl(asset);
  logInfo("orchestration", `downloading uv ${UV_VERSION} from ${url}`);
  const [archiveBytes, expectedSha] = await Promise.all([
    fetchBytes(url),
    fetchSha256(`${url}.sha256`)
  ]);
  const actualSha = await sha256Hex(archiveBytes);
  if (actualSha !== expectedSha) {
    throw new Error(`uv archive checksum mismatch.
  expected: ${expectedSha}
  actual:   ${actualSha}`);
  }
  logInfo("orchestration", "uv archive checksum verified");
  await Deno.mkdir(RUNTIME_BIN_DIR, {
    recursive: true
  });
  await Deno.mkdir(CACHE_DIR, {
    recursive: true
  });
  await extractUv(archiveBytes, asset);
  const version = await installedUvVersion();
  if (version !== UV_VERSION) {
    throw new Error(`uv install verification failed: expected ${UV_VERSION}, got ${version ?? "none"}`);
  }
  await repointUvCurrent();
  logInfo("orchestration", `uv ${UV_VERSION} installed at ${UV_BIN}`);
}
async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
async function fetchSha256(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download checksum ${url}: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const hex = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Unexpected checksum content from ${url}: "${text.trim()}"`);
  }
  return hex;
}
async function extractUv(archiveBytes, asset) {
  const tmpDir = await Deno.makeTempDir({
    prefix: "turbopanel-uv-"
  });
  try {
    const archivePath = join3(tmpDir, asset);
    await Deno.writeFile(archivePath, archiveBytes);
    await runLogged("tar", [
      "-xzf",
      archivePath,
      "-C",
      tmpDir
    ], {
      level: "DEBUG",
      component: "uv"
    });
    const innerDir = join3(tmpDir, asset.replace(/\.tar\.gz$/, ""));
    for (const [src, dst] of [
      [
        join3(innerDir, "uv"),
        UV_BIN
      ],
      [
        join3(innerDir, "uvx"),
        UVX_BIN
      ]
    ]) {
      await Deno.copyFile(src, dst);
      await Deno.chmod(dst, 493);
    }
  } finally {
    await Deno.remove(tmpDir, {
      recursive: true
    }).catch(() => {
    });
  }
}
var init_uv = __esm({
  "src/orchestration/uv.ts"() {
    init_hex();
    init_mod();
    init_exec();
    init_logger();
    init_paths();
  }
});

// src/orchestration/installer-tui.ts
function parseTaskName(full) {
  const match = full.match(/^\s*([^:]+)\s*:\s*(.+)$/);
  if (match) {
    return {
      role: match[1].trim(),
      task: match[2].trim()
    };
  }
  return {
    role: null,
    task: full.trim()
  };
}
function taskLabel(full) {
  const { role, task } = parseTaskName(full);
  return role ? `${role} \u203A ${task}` : task;
}
function hostMessages(hosts) {
  const messages = [];
  for (const result of Object.values(hosts)) {
    const msg = result.msg;
    if (typeof msg === "string" && msg.length > 0) {
      messages.push(msg);
    }
  }
  return messages.join("; ");
}
function buildRecap(stats) {
  let ok = 0;
  let changed = 0;
  let failed = 0;
  for (const hostStats of Object.values(stats)) {
    ok += hostStats.ok ?? 0;
    changed += hostStats.changed ?? 0;
    failed += hostStats.failures ?? hostStats.failed ?? 0;
  }
  return `ok=${ok} changed=${changed} failed=${failed}`;
}
function upsertTask(tasks, row) {
  const index = tasks.findIndex((task) => task.id === row.id);
  if (index < 0) {
    tasks.push(row);
  } else {
    tasks[index] = row;
  }
}
function completeRunning(tasks, finalStatus) {
  for (const task of tasks) {
    if (task.status === "running") {
      task.status = finalStatus;
    }
  }
}
function pinnedIndices(tasks) {
  const indices = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const status = tasks[index].status;
    if (status === "running" || status === "failed") {
      indices.push(index);
    }
  }
  return indices;
}
function buildTaskView(tasks, maxRows) {
  if (tasks.length === 0) {
    return {
      visibleTasks: [],
      hiddenCount: 0,
      followIndex: 0
    };
  }
  const budget = Math.max(1, maxRows);
  const needsHidden = tasks.length > budget;
  const windowRows = needsHidden ? Math.max(1, budget - 1) : budget;
  const pinned = pinnedIndices(tasks);
  const focusIndex = pinned.length > 0 ? pinned[pinned.length - 1] : tasks.length - 1;
  let start = Math.max(0, focusIndex - windowRows + 1);
  let end = start + windowRows;
  if (pinned.length > 0) {
    start = Math.min(start, pinned[0]);
    end = Math.max(end, pinned[pinned.length - 1] + 1);
  }
  if (end - start > windowRows) {
    start = Math.max(0, end - windowRows);
  }
  if (end > tasks.length) {
    end = tasks.length;
    start = Math.max(0, end - windowRows);
  }
  const visibleTasks = tasks.slice(start, end);
  const followIndex = Math.min(Math.max(0, focusIndex - start), Math.max(0, visibleTasks.length - 1));
  return {
    visibleTasks,
    hiddenCount: start,
    followIndex
  };
}
function spinnerFrames(depth) {
  return depth >= 2 ? DOT_FRAMES : BRAILLE_FRAMES;
}
function truncateLabel(label, maxLen) {
  if (maxLen <= 0) return "";
  if (label.length <= maxLen) return label;
  if (maxLen <= 1) return "\u2026";
  return `${label.slice(0, maxLen - 1)}\u2026`;
}
function createInstallerTui() {
  if (!Deno.stdout.isTerminal()) {
    return null;
  }
  return new InstallerTUI();
}
var CLEAR, HIDE_CURSOR, SHOW_CURSOR, RESET, CYAN, GREEN, YELLOW, RED, DIM, BOLD, BRAILLE_FRAMES, DOT_FRAMES, InstallerTUI;
var init_installer_tui = __esm({
  "src/orchestration/installer-tui.ts"() {
    init_build_info();
    CLEAR = "\x1B[2J\x1B[H";
    HIDE_CURSOR = "\x1B[?25l";
    SHOW_CURSOR = "\x1B[?25h";
    RESET = "\x1B[0m";
    CYAN = "\x1B[36m";
    GREEN = "\x1B[32m";
    YELLOW = "\x1B[33m";
    RED = "\x1B[31m";
    DIM = "\x1B[90m";
    BOLD = "\x1B[1m";
    BRAILLE_FRAMES = [
      "\u280B",
      "\u2819",
      "\u2839",
      "\u2838",
      "\u283C",
      "\u2834",
      "\u2826",
      "\u2827",
      "\u2807",
      "\u280F"
    ];
    DOT_FRAMES = [
      ".",
      "o",
      "O",
      "o"
    ];
    InstallerTUI = class {
      tasks = [];
      recap = null;
      error = null;
      spinnerFrame = 0;
      intervalId = null;
      enc = new TextEncoder();
      #sigintHandler = null;
      start() {
        Deno.stdout.writeSync(this.enc.encode(HIDE_CURSOR));
        this.#sigintHandler = () => {
          this.finish(false, "Interrupted");
          Deno.exit(130);
        };
        Deno.addSignalListener("SIGINT", this.#sigintHandler);
        this.emitStep("Preparing installation\u2026", "running", "step:prepare");
        this.render();
        this.intervalId = setInterval(() => {
          this.spinnerFrame++;
          this.render();
        }, 100);
      }
      render() {
        let columns = 80;
        let rows = 24;
        try {
          const size = Deno.consoleSize();
          columns = size.columns;
          rows = size.rows;
        } catch {
        }
        const build = getBuildInfo();
        const maxTaskRows = Math.max(1, rows - 10);
        const view = buildTaskView(this.tasks, maxTaskRows);
        const lines = [];
        lines.push(CLEAR + HIDE_CURSOR);
        lines.push("");
        lines.push("  \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E");
        lines.push("  \u2502  \u26A1 TurboPanel  \xB7  Daemon Installer     \u2502");
        const versionInner = `  v${build.commit} \xB7 ${build.channel}`;
        lines.push(`  \u2502${versionInner.padEnd(41)} \u2502`);
        lines.push("  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F");
        lines.push("");
        if (view.hiddenCount > 0) {
          lines.push(`  ${DIM}\u2191 ${view.hiddenCount} earlier step(s) hidden${RESET}`);
        }
        for (const task of view.visibleTasks) {
          const indent = "  ".repeat(task.depth);
          const prefix = "  " + indent;
          const maxLabelLen = columns - prefix.length - 3;
          const label = truncateLabel(task.label, maxLabelLen);
          let glyph;
          switch (task.status) {
            case "running": {
              const frames = spinnerFrames(task.depth);
              const frame = frames[this.spinnerFrame % frames.length];
              const color = task.depth >= 2 ? YELLOW : CYAN;
              glyph = `${color}${frame}${RESET}`;
              break;
            }
            case "ok":
              glyph = `${GREEN}\u2713${RESET}`;
              break;
            case "changed":
              glyph = `${YELLOW}~${RESET}`;
              break;
            case "failed":
              glyph = `${RED}\u2717${RESET}`;
              break;
            case "skipped":
              glyph = `${DIM}\u2013${RESET}`;
              break;
          }
          lines.push(`${prefix}${glyph} ${label}`);
        }
        const ruleWidth = Math.min(columns - 4, 41);
        lines.push("");
        lines.push(`  ${"\u2500".repeat(ruleWidth)}`);
        const lastRunning = [
          ...this.tasks
        ].reverse().find((t) => t.status === "running");
        if (this.error) {
          lines.push(`  ${RED}${BOLD}\u2717 Error${RESET} ${this.error}`);
        } else if (this.recap) {
          lines.push(`  ${DIM}${this.recap}${RESET}`);
        } else if (lastRunning) {
          lines.push(`  \u25B8 ${lastRunning.label}`);
        }
        lines.push("");
        Deno.stdout.writeSync(this.enc.encode(lines.join("\n")));
      }
      onEvent(event) {
        switch (event._event) {
          case "v2_playbook_on_play_start": {
            const playEvent = event;
            const name = playEvent.play.name.trim() || "play";
            const playId = `play:${playEvent.play.id}`;
            for (const task of this.tasks) {
              if (task.depth === 1 && task.status === "running") {
                task.status = "ok";
              }
            }
            upsertTask(this.tasks, {
              id: playId,
              label: name,
              status: "running",
              depth: 1
            });
            break;
          }
          case "v2_playbook_on_task_start":
          case "v2_playbook_on_handler_task_start":
          case "v2_runner_on_start": {
            const taskEvent = event;
            const rawName = taskEvent.task.name ?? "task";
            const id = `task:${taskEvent.task.id}`;
            upsertTask(this.tasks, {
              id,
              label: taskLabel(rawName),
              status: "running",
              depth: 2
            });
            break;
          }
          case "v2_runner_on_ok": {
            const okEvent = event;
            const rawName = okEvent.task.name ?? "task";
            const id = `task:${okEvent.task.id}`;
            const hostResult = Object.values(okEvent.hosts)[0];
            const changed = hostResult?.changed === true;
            upsertTask(this.tasks, {
              id,
              label: taskLabel(rawName),
              status: changed ? "changed" : "ok",
              depth: 2
            });
            break;
          }
          case "v2_runner_on_skipped": {
            const skippedEvent = event;
            const rawName = skippedEvent.task.name ?? "task";
            const id = `task:${skippedEvent.task.id}`;
            upsertTask(this.tasks, {
              id,
              label: taskLabel(rawName),
              status: "skipped",
              depth: 2
            });
            break;
          }
          case "v2_runner_on_failed":
          case "v2_runner_on_unreachable": {
            const failedEvent = event;
            const rawName = failedEvent.task.name ?? "task";
            const id = `task:${failedEvent.task.id}`;
            upsertTask(this.tasks, {
              id,
              label: taskLabel(rawName),
              status: "failed",
              depth: 2
            });
            this.error = hostMessages(failedEvent.hosts) || "task failed";
            break;
          }
          case "v2_playbook_on_stats": {
            const statsEvent = event;
            let failed = 0;
            for (const hostStats of Object.values(statsEvent.stats)) {
              failed += hostStats.failures ?? hostStats.failed ?? 0;
            }
            const finalStatus = failed > 0 ? "failed" : "ok";
            completeRunning(this.tasks, finalStatus);
            this.recap = buildRecap(statsEvent.stats);
            break;
          }
        }
      }
      emitStep(label, status, id) {
        const stepId = id ?? `step:${label}`;
        if (status === "running") {
          for (const task of this.tasks) {
            if (task.depth === 0 && task.status === "running" && task.id !== stepId) {
              task.status = "ok";
            }
          }
        }
        upsertTask(this.tasks, {
          id: stepId,
          label,
          status,
          depth: 0
        });
      }
      finish(ok, message) {
        if (this.intervalId !== null) {
          clearInterval(this.intervalId);
          this.intervalId = null;
        }
        if (ok) {
          completeRunning(this.tasks, "ok");
          if (!this.recap) {
            this.recap = message;
          }
        } else {
          completeRunning(this.tasks, "failed");
          this.error = message;
        }
        this.render();
        Deno.stdout.writeSync(this.enc.encode(SHOW_CURSOR));
        if (this.#sigintHandler) {
          Deno.removeSignalListener("SIGINT", this.#sigintHandler);
          this.#sigintHandler = null;
        }
      }
    };
  }
});

// src/instance/paths.ts
function resolveInstanceSocket(env = Deno.env.toObject()) {
  const override = env.TURBOPANEL_SOCKET?.trim();
  if (override) return override;
  const layout4 = resolveLayout(env);
  const dir = env.TURBOPANEL_SOCKET_DIR?.trim() || layout4.runDir;
  return `${dir.replace(/\/$/, "")}/${INSTANCE_SOCKET}`;
}
function httpToWs(url) {
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`;
  }
  if (url.startsWith("http://")) return `ws://${url.slice("http://".length)}`;
  throw new Error(`TURBOPANEL_INSTANCE_URL must start with http:// or https:// (got "${url}")`);
}
function resolveInstanceConfig(env = Deno.env.toObject()) {
  const url = env.TURBOPANEL_INSTANCE_URL?.trim();
  if (url) {
    const baseUrl = url.replace(/\/+$/, "");
    return {
      kind: "url",
      baseUrl,
      wsBaseUrl: httpToWs(baseUrl)
    };
  }
  return {
    kind: "socket",
    socketPath: resolveInstanceSocket(env)
  };
}
function joinPath(base, path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}
function instanceUrl(config, path) {
  const base = config.kind === "url" ? config.baseUrl : INSTANCE_HTTP_ORIGIN;
  return joinPath(base, path);
}
function instanceWebSocketUrl(config, path = "/ws/daemon/v1") {
  const base = config.kind === "url" ? config.wsBaseUrl : INSTANCE_WS_ORIGIN;
  return joinPath(base, path);
}
function describeInstance(config) {
  return config.kind === "url" ? config.baseUrl : `unix://${config.socketPath}`;
}
function isTruthyFlag(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
function stripTrailingSlash2(path) {
  return path.replace(/\/+$/, "");
}
function resolveServerIdentityDir(env = Deno.env.toObject()) {
  if (isTruthyFlag(env.TURBOPANEL_SKIP_ORCHESTRATION)) {
    return stripTrailingSlash2(Deno.cwd());
  }
  return resolveLayout(env).daemonStateDir;
}
function resolveServerKeyPath(env = Deno.env.toObject()) {
  return `${resolveServerIdentityDir(env)}/${SERVER_KEY_FILE}`;
}
function resolveInstanceCaPath(env = Deno.env.toObject()) {
  const fromEnv = env.TURBOPANEL_INSTANCE_CA?.trim();
  let resolved;
  if (fromEnv) {
    try {
      Deno.statSync(fromEnv);
      resolved = fromEnv;
    } catch {
    }
  }
  if (!resolved) {
    try {
      Deno.statSync(CANONICAL_INSTANCE_CA_PATH);
      resolved = CANONICAL_INSTANCE_CA_PATH;
    } catch {
      resolved = void 0;
    }
  }
  return resolved;
}
async function createInstanceHttpClient(config, options = {}) {
  if (config.kind === "socket") {
    return Deno.createHttpClient({
      proxy: {
        transport: "unix",
        path: config.socketPath
      }
    });
  }
  if (config.baseUrl.startsWith("http://")) {
    return void 0;
  }
  if (options.caCertPath) {
    const cert = await Deno.readTextFile(options.caCertPath);
    return Deno.createHttpClient({
      caCerts: [
        cert
      ]
    });
  }
  return void 0;
}
var layout2, DEFAULT_SOCKET_DIR, INSTANCE_SOCKET, INSTANCE_HTTP_ORIGIN, INSTANCE_WS_ORIGIN, CANONICAL_INSTANCE_CA_PATH, SERVER_KEY_FILE;
var init_paths2 = __esm({
  "src/instance/paths.ts"() {
    init_layout();
    layout2 = resolveLayout({
      TURBOPANEL_RUN_DIR: readEnv("TURBOPANEL_RUN_DIR"),
      TURBOPANEL_CONFIG_DIR: readEnv("TURBOPANEL_CONFIG_DIR"),
      TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT")
    });
    DEFAULT_SOCKET_DIR = layout2.runDir;
    INSTANCE_SOCKET = "instance.sock";
    INSTANCE_HTTP_ORIGIN = "http://instance";
    INSTANCE_WS_ORIGIN = "ws://instance";
    CANONICAL_INSTANCE_CA_PATH = layout2.instanceCaPath;
    SERVER_KEY_FILE = "server-key.json";
  }
});

// src/orchestration/setup.ts
function shouldSkipOrchestration() {
  const flag = Deno.env.get("TURBOPANEL_SKIP_ORCHESTRATION")?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}
function shouldInstallDevInstance() {
  const flag = Deno.env.get("TURBOPANEL_DEV_INSTANCE")?.trim().toLowerCase();
  const enabled = flag === "1" || flag === "true" || flag === "yes";
  if (!enabled) return false;
  if (resolveInstanceConfig().kind === "socket") return true;
  return Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME")?.trim() === "workers";
}
function isPreOptInCoLocatedDev() {
  if (shouldInstallDevInstance()) return false;
  if (resolveInstanceConfig().kind === "socket") return true;
  return Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME")?.trim() === "workers";
}
function shouldConnectToInstance() {
  if (shouldSkipOrchestration()) return true;
  return !isPreOptInCoLocatedDev();
}
function shouldEnableDockerIntegration() {
  if (shouldSkipOrchestration()) return false;
  if (isPreOptInCoLocatedDev()) return false;
  if (shouldInstallDevInstance()) return true;
  if (shouldRunDaemonConverge()) return true;
  return false;
}
function shouldRunDaemonConverge() {
  if (isPreOptInCoLocatedDev()) return false;
  return resolveInstanceConfig().kind === "url";
}
async function initOrchestration() {
  if (shouldSkipOrchestration()) {
    logInfo("orchestration", "skipped (TURBOPANEL_SKIP_ORCHESTRATION)");
    return false;
  }
  const started = performance.now();
  logInfo("orchestration", "bootstrapping runtime");
  const preOptInDev = isPreOptInCoLocatedDev();
  const steps = [
    [
      "ensureOrchestrationTree",
      ensureOrchestrationTree
    ],
    [
      "ensureUv",
      ensureUv
    ],
    [
      "ensurePython",
      ensurePython
    ],
    [
      "bootstrapOrchestrationRuntime",
      bootstrapOrchestrationRuntime
    ]
  ];
  if (shouldRunDaemonConverge()) {
    steps.push([
      "runDaemonConverge",
      runDaemonConverge
    ]);
  } else if (preOptInDev) {
    logInfo("orchestration", "co-located dev host awaiting opt-in (TURBOPANEL_DEV_INSTANCE); skipping converge");
  }
  try {
    for (const [, step] of steps) {
      await step();
    }
    const elapsed = ((performance.now() - started) / 1e3).toFixed(1);
    logInfo("orchestration", `runtime ready in ${elapsed}s`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("orchestration", "bootstrap failed:", message);
    logError("orchestration", "daemon will continue running without a verified runtime");
    return false;
  }
}
async function runInstaller(opts) {
  const varsFile = await Deno.makeTempFile();
  const tui = createInstallerTui();
  tui?.start();
  try {
    const lines = [
      `turbopanel_instance_url: ${opts.instanceUrl}`,
      `turbopanel_start: ${opts.start}`
    ];
    if (opts.instanceCa) {
      let stat;
      try {
        stat = Deno.statSync(opts.instanceCa);
      } catch {
        throw new Error(`Instance CA file not found or unreadable: ${opts.instanceCa}`);
      }
      if (!stat.isFile) {
        throw new Error(`Instance CA path is not a file: ${opts.instanceCa}`);
      }
      lines.push(`turbopanel_instance_ca: ${opts.instanceCa}`);
    }
    if (opts.tunnelToken?.trim()) {
      lines.push(`turbopanel_tunnel_token: ${opts.tunnelToken.trim()}`);
    }
    await Deno.writeTextFile(varsFile, `${lines.join("\n")}
`);
    const onEvent = (event) => {
      tui?.onEvent(event);
    };
    await runLocalPlaybook(DAEMON_INSTALL_PLAYBOOK, [
      "-e",
      `@${varsFile}`
    ], onEvent, void 0, tui !== null);
    tui?.finish(true, "TurboPanel daemon installed successfully");
    logInfo("installer", "daemon provisioning complete");
  } catch (err) {
    tui?.finish(false, err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    try {
      await Deno.remove(varsFile);
    } catch {
    }
  }
}
var init_setup = __esm({
  "src/orchestration/setup.ts"() {
    init_ansible();
    init_bundle_extract();
    init_installer_tui();
    init_python();
    init_uv();
    init_paths2();
    init_logger();
    init_paths();
  }
});

// src/docker/client.ts
function resolveDockerSocket(env = Deno.env.toObject()) {
  const override = env.TURBOPANEL_DOCKER_SOCKET?.trim();
  if (override) return override;
  return "/var/run/docker.sock";
}
var DOCKER_HTTP_ORIGIN, DockerClient;
var init_client = __esm({
  "src/docker/client.ts"() {
    init_logger();
    DOCKER_HTTP_ORIGIN = "http://docker";
    DockerClient = class {
      #httpClient;
      #closed = false;
      constructor(socketPath) {
        const path = socketPath ?? resolveDockerSocket();
        this.#httpClient = Deno.createHttpClient({
          proxy: {
            transport: "unix",
            path
          }
        });
      }
      async ping() {
        try {
          const response = await this.#fetch("/_ping");
          return response.status === 200;
        } catch {
          return false;
        }
      }
      async listContainers(all = false) {
        const response = await this.#fetch(`/containers/json?all=${all ? "true" : "false"}`);
        if (!response.ok) {
          throw new Error(`list containers failed: HTTP ${response.status}`);
        }
        return await response.json();
      }
      async inspectContainer(id) {
        const response = await this.#fetch(`/containers/${id}/json`);
        if (!response.ok) {
          throw new Error(`inspect container failed: HTTP ${response.status}`);
        }
        return await response.json();
      }
      async startContainer(id) {
        const response = await this.#fetch(`/containers/${id}/start`, {
          method: "POST"
        });
        if (!response.ok && response.status !== 304) {
          throw new Error(`start container failed: HTTP ${response.status}`);
        }
      }
      async stopContainer(id, timeoutSecs) {
        const query = timeoutSecs !== void 0 ? `?t=${timeoutSecs}` : "";
        const response = await this.#fetch(`/containers/${id}/stop${query}`, {
          method: "POST"
        });
        if (!response.ok && response.status !== 304) {
          throw new Error(`stop container failed: HTTP ${response.status}`);
        }
      }
      async *streamEvents(signal) {
        const filters = {
          type: [
            "container"
          ],
          event: [
            "start",
            "stop",
            "die",
            "destroy",
            "remove",
            "restart",
            "oom",
            "health_status",
            "kill",
            "pause",
            "unpause"
          ]
        };
        const query = `?filters=${encodeURIComponent(JSON.stringify(filters))}`;
        let response;
        try {
          response = await this.#fetch(`/events${query}`, {
            signal
          });
        } catch (error) {
          if (signal.aborted || error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          if (error instanceof Deno.errors.BadResource) {
            return;
          }
          throw error;
        }
        if (!response.ok || !response.body) {
          throw new Error(`stream events failed: HTTP ${response.status}`);
        }
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        try {
          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += value;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                yield JSON.parse(trimmed);
              } catch {
                logWarn("docker-client", "events stream: invalid json line");
              }
            }
          }
        } catch (error) {
          if (signal.aborted || error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          if (error instanceof Deno.errors.BadResource) {
            return;
          }
          throw error;
        } finally {
          try {
            reader.releaseLock();
          } catch {
          }
        }
      }
      close() {
        if (this.#closed) {
          return;
        }
        this.#closed = true;
        try {
          this.#httpClient.close();
        } catch (error) {
          if (!(error instanceof Deno.errors.BadResource)) {
            throw error;
          }
        }
      }
      #fetch(path, init = {}) {
        const normalized = path.startsWith("/") ? path : `/${path}`;
        return fetch(`${DOCKER_HTTP_ORIGIN}${normalized}`, {
          ...init,
          client: this.#httpClient
        });
      }
    };
  }
});

// src/docker/monitor.ts
function isContainerNotFound(err) {
  return err instanceof Error && err.message.includes("HTTP 404");
}
function isDockerUnavailable(err) {
  if (!(err instanceof Error)) return false;
  const message = err.message;
  return message.includes("No such file or directory") || message.includes("os error 2") || message.includes("Connection refused") || message.includes("os error 111") || message.includes("client error (Connect)");
}
function isContainerDestroyEvent(event) {
  return event.Action === "destroy" || event.Action === "remove";
}
function delay(ms, signal) {
  return new Promise((resolve3) => {
    if (signal.aborted) {
      resolve3();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve3();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", onAbort);
  });
}
var DockerMonitor;
var init_monitor = __esm({
  "src/docker/monitor.ts"() {
    init_logger();
    DockerMonitor = class {
      #client;
      #pollIntervalMs;
      #reconcileIntervalMs;
      #containers = [];
      #inspects = /* @__PURE__ */ new Map();
      #listeners = /* @__PURE__ */ new Set();
      #eventsBackoffMs = 1e3;
      #usingPollFallback = false;
      /** Tri-state docker reachability: null = unknown, true/false after first probe. */
      #dockerReachable = null;
      #readyPromise;
      #markReady;
      constructor(client, pollIntervalMs = 1e4, reconcileIntervalMs = 3e4) {
        this.#client = client;
        this.#pollIntervalMs = pollIntervalMs;
        this.#reconcileIntervalMs = reconcileIntervalMs;
        let markReady;
        this.#readyPromise = new Promise((resolve3) => {
          markReady = resolve3;
        });
        this.#markReady = () => {
          markReady();
          this.#markReady = () => {
          };
        };
      }
      waitUntilReady() {
        return this.#readyPromise;
      }
      /** Mark Docker reachable; log only when transitioning from unavailable. */
      #markDockerReachable() {
        if (this.#dockerReachable === false) {
          logInfo("docker-monitor", "Docker socket is now reachable");
        }
        this.#dockerReachable = true;
      }
      /**
       * Record that Docker is unavailable. Logs once on transition (info, not warn)
       * so an intentionally Docker-less managed node doesn't flood the error log.
       * Returns true if this was a state transition.
       */
      #markDockerUnavailable(reason) {
        const transitioned = this.#dockerReachable !== false;
        if (transitioned) {
          logInfo("docker-monitor", `Docker socket unavailable (${reason}); will retry quietly until Docker is installed`);
        }
        this.#dockerReachable = false;
        return transitioned;
      }
      getContainers() {
        return this.#containers;
      }
      getContainerInspect(id) {
        return this.#inspects.get(id);
      }
      subscribe(listener) {
        this.#listeners.add(listener);
        return () => {
          this.#listeners.delete(listener);
        };
      }
      start(signal) {
        void this.#reconcileAll(signal);
        void this.#eventsLoop(signal);
        void this.#reconcileLoop(signal);
      }
      async #reconcileAll(signal) {
        if (signal.aborted) return;
        try {
          const summaries = await this.#client.listContainers(true);
          this.#containers = summaries;
          const inspects = /* @__PURE__ */ new Map();
          for (const summary of summaries) {
            if (signal.aborted) return;
            try {
              const inspect = await this.#client.inspectContainer(summary.Id);
              inspects.set(summary.Id, inspect);
            } catch (err) {
              logWarn("docker-monitor", "inspect failed:", err instanceof Error ? err.message : err);
            }
          }
          this.#inspects = inspects;
          for (const summary of summaries) {
            this.#notify({
              containerId: summary.Id,
              summary,
              inspect: inspects.get(summary.Id)
            });
          }
          this.#markDockerReachable();
        } catch (err) {
          if (isDockerUnavailable(err)) {
            this.#markDockerUnavailable("reconcile");
          } else {
            logWarn("docker-monitor", "reconcile failed:", err instanceof Error ? err.message : err);
          }
        } finally {
          this.#markReady();
        }
      }
      async #reconcileLoop(signal) {
        while (!signal.aborted) {
          await delay(this.#reconcileIntervalMs, signal);
          if (signal.aborted) break;
          await this.#reconcileAll(signal);
        }
      }
      async #eventsLoop(signal) {
        while (!signal.aborted) {
          let streamedAny = false;
          try {
            this.#usingPollFallback = false;
            for await (const event of this.#client.streamEvents(signal)) {
              if (signal.aborted) return;
              streamedAny = true;
              this.#markDockerReachable();
              this.#eventsBackoffMs = 1e3;
              await this.#handleEvent(event, signal);
            }
            if (signal.aborted) return;
          } catch (err) {
            if (signal.aborted) return;
            if (isDockerUnavailable(err)) {
              this.#markDockerUnavailable("events stream");
            } else {
              logWarn("docker-monitor", "events stream failed:", err instanceof Error ? err.message : err);
            }
          }
          if (signal.aborted) return;
          if (!this.#usingPollFallback) {
            this.#usingPollFallback = true;
            void this.#pollLoop(signal);
          }
          if (streamedAny) {
            this.#eventsBackoffMs = 1e3;
          }
          await delay(this.#eventsBackoffMs, signal);
          this.#eventsBackoffMs = Math.min(this.#eventsBackoffMs * 2, 6e4);
        }
      }
      async #handleEvent(event, signal) {
        const containerId = event.Actor?.ID;
        if (!containerId) return;
        if (isContainerDestroyEvent(event)) {
          this.#removeContainer(containerId, event);
          return;
        }
        try {
          const inspect = await this.#client.inspectContainer(containerId);
          this.#inspects.set(containerId, inspect);
          const summaryIndex = this.#containers.findIndex((c) => c.Id === containerId);
          let summary;
          if (summaryIndex >= 0) {
            summary = this.#containers[summaryIndex];
          } else {
            try {
              const summaries = await this.#client.listContainers(true);
              this.#containers = summaries;
              summary = summaries.find((c) => c.Id === containerId);
            } catch (err) {
              logWarn("docker-monitor", "list after event failed:", err instanceof Error ? err.message : err);
            }
          }
          this.#notify({
            containerId,
            summary,
            inspect,
            event
          });
        } catch (err) {
          if (signal.aborted) return;
          if (isContainerNotFound(err)) {
            this.#removeContainer(containerId, event);
            return;
          }
          logWarn("docker-monitor", "event refresh failed:", err instanceof Error ? err.message : err);
        }
      }
      #removeContainer(containerId, event) {
        const summary = this.#containers.find((container) => container.Id === containerId);
        const inspect = this.#inspects.get(containerId);
        const wasTracked = summary !== void 0 || inspect !== void 0;
        this.#containers = this.#containers.filter((container) => container.Id !== containerId);
        this.#inspects.delete(containerId);
        if (!wasTracked) return;
        this.#notify({
          containerId,
          summary,
          inspect,
          event,
          removed: true
        });
      }
      async #pollLoop(signal) {
        while (!signal.aborted && this.#usingPollFallback) {
          await delay(this.#pollIntervalMs, signal);
          if (signal.aborted || !this.#usingPollFallback) break;
          await this.#reconcileAll(signal);
        }
      }
      #notify(change) {
        for (const listener of this.#listeners) {
          try {
            listener(change);
          } catch (err) {
            logWarn("docker-monitor", "listener failed:", err instanceof Error ? err.message : err);
          }
        }
      }
    };
  }
});

// src/docker/index.ts
var init_docker = __esm({
  "src/docker/index.ts"() {
    init_client();
    init_monitor();
  }
});

// src/instance/restart-daemon-service.ts
function stripLogInjection(text) {
  return text.replace(/[\r\n\t]/g, " ");
}
function buildDaemonRestartSystemctlArgs(unit = DEFAULT_DAEMON_UNIT) {
  return [
    [
      "-n",
      "systemctl",
      "enable",
      unit
    ],
    [
      "-n",
      "systemctl",
      "restart",
      unit
    ]
  ];
}
function resolveDaemonServiceUnit(env = Deno.env.toObject()) {
  const trimmed = env.TURBOPANEL_SERVICE_NAME?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_DAEMON_UNIT;
}
async function restartDaemonService(options = {}) {
  const unit = options.unit ?? resolveDaemonServiceUnit();
  const runSystemctl = options.runSystemctl ?? (async (args) => {
    const result = await new Deno.Command("sudo", {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped"
    }).output();
    return {
      success: result.success,
      stderr: new TextDecoder().decode(result.stderr).trim()
    };
  });
  for (const args of buildDaemonRestartSystemctlArgs(unit)) {
    const result = await runSystemctl(args);
    if (!result.success) {
      const safeUnit = stripLogInjection(unit);
      const safeArgs = stripLogInjection(args.join(" "));
      const safeStderr = stripLogInjection(result.stderr || "unknown error");
      logWarn("daemon", "sudo", safeArgs, safeUnit, "failed:", safeStderr);
      return false;
    }
  }
  return true;
}
var DEFAULT_DAEMON_UNIT;
var init_restart_daemon_service = __esm({
  "src/instance/restart-daemon-service.ts"() {
    init_logger();
    DEFAULT_DAEMON_UNIT = "turbopanel-daemon";
  }
});

// src/instance/commands/contracts.ts
function isValidHostname(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.length > HOSTNAME_MAX_LENGTH) return false;
  if (/[A-Z]/.test(value)) return false;
  if (/\s/.test(value)) return false;
  if (SHELL_METACHAR_RE.test(value)) return false;
  return HOSTNAME_RE.test(value);
}
function assertValidHostname(value) {
  if (!isValidHostname(value)) {
    throw new Error("Invalid hostname");
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parsePingPayload(value) {
  if (!isRecord(value)) {
    throw new Error("Invalid ping payload");
  }
  return {};
}
function parseRebootPayload(value) {
  if (!isRecord(value)) {
    throw new Error("Invalid reboot payload");
  }
  return {};
}
function parseHostnamePayload(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid hostname payload");
  }
  const record = value;
  const hostname = record.hostname;
  if (typeof hostname !== "string" || hostname.length === 0) {
    throw new Error("hostname must be a non-empty string");
  }
  assertValidHostname(hostname);
  return {
    hostname
  };
}
var HOSTNAME_RE, HOSTNAME_MAX_LENGTH, SHELL_METACHAR_RE;
var init_contracts = __esm({
  "src/instance/commands/contracts.ts"() {
    HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
    HOSTNAME_MAX_LENGTH = 253;
    SHELL_METACHAR_RE = /[;|&$`()<>\\"'!*?{}]/;
  }
});

// src/instance/commands/hostname.ts
async function isAnsibleRuntimeAvailable() {
  if (ansibleAvailabilityCheckOverride) {
    return ansibleAvailabilityCheckOverride();
  }
  const { ansiblePlaybookWorks: ansiblePlaybookWorks2 } = await Promise.resolve().then(() => (init_ansible(), ansible_exports));
  return ansiblePlaybookWorks2();
}
async function handleHostname(payload, _daemonReceivedAt) {
  assertValidHostname(payload.hostname);
  if (!await isAnsibleRuntimeAvailable()) {
    throw new Error("Ansible/bootstrap runtime is missing");
  }
  logInfo("commands", `setting hostname to ${payload.hostname}`);
  const { runSetHostname: runSetHostname2 } = await Promise.resolve().then(() => (init_ansible(), ansible_exports));
  const { summary } = await runSetHostname2(payload.hostname);
  const observedHostname = Deno.hostname();
  logInfo("commands", `hostname set; observed ${observedHostname}`);
  return {
    observedHostname,
    ...summary.length > 0 ? {
      summary
    } : {}
  };
}
var ansibleAvailabilityCheckOverride;
var init_hostname = __esm({
  "src/instance/commands/hostname.ts"() {
    init_logger();
    init_contracts();
    ansibleAvailabilityCheckOverride = null;
  }
});

// src/instance/commands/ping.ts
function handlePing(daemonReceivedAt) {
  const daemonRespondedAt = (/* @__PURE__ */ new Date()).toISOString();
  const build = getBuildInfo();
  return {
    daemonReceivedAt,
    daemonRespondedAt,
    daemonHostname: Deno.hostname(),
    daemonBuild: {
      commit: build.commit,
      buildId: build.buildId,
      builtAt: build.builtAt,
      channel: build.channel
    }
  };
}
var init_ping = __esm({
  "src/instance/commands/ping.ts"() {
    init_build_info();
  }
});

// src/instance/commands/reboot.ts
function stripLogInjection2(text) {
  return text.replaceAll("\n", "_").replaceAll("\r", "_").replaceAll("	", "_");
}
async function handleReboot(payload, _daemonReceivedAt) {
  parseRebootPayload(payload);
  logInfo("commands", "scheduling system reboot");
  const executor = rebootExecutorOverride ?? runRebootDefault;
  setTimeout(async () => {
    const result = await executor();
    if (!result.success) {
      logWarn("commands", "reboot failed:", stripLogInjection2(result.stderr));
    }
  }, REBOOT_HANDOFF_DELAY_MS);
  return {
    scheduled: true
  };
}
var REBOOT_HANDOFF_DELAY_MS, rebootExecutorOverride, runRebootDefault;
var init_reboot = __esm({
  "src/instance/commands/reboot.ts"() {
    init_logger();
    init_contracts();
    REBOOT_HANDOFF_DELAY_MS = 2e3;
    rebootExecutorOverride = null;
    runRebootDefault = async () => {
      const result = await new Deno.Command("sudo", {
        args: [
          "-n",
          "systemctl",
          "reboot"
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped"
      }).output();
      return {
        success: result.success,
        stderr: new TextDecoder().decode(result.stderr).trim()
      };
    };
  }
});

// src/instance/commands/command-router.ts
function stripLogInjection3(text) {
  return text.replaceAll("\n", "_").replaceAll("\r", "_").replaceAll("	", "_");
}
function sanitizeError(value, maxLen = 500) {
  let text;
  if (value instanceof Error) {
    text = value.message;
  } else if (typeof value === "string") {
    text = value;
  } else {
    text = String(value);
  }
  text = stripLogInjection3(text);
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
function sendOutcome(ws, outcome) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(outcome));
  }
}
async function handleCommandDispatch(message, ws, _deps) {
  const daemonReceivedAt = (/* @__PURE__ */ new Date()).toISOString();
  const ack = {
    type: "command-ack",
    id: message.id,
    at: (/* @__PURE__ */ new Date()).toISOString(),
    daemonReceivedAt
  };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(ack));
  }
  try {
    let ok;
    let result;
    let error;
    let daemonRespondedAt = (/* @__PURE__ */ new Date()).toISOString();
    switch (message.commandType) {
      case "daemon.ping":
        parsePingPayload(message.payload);
        result = handlePing(daemonReceivedAt);
        ok = true;
        daemonRespondedAt = result.daemonRespondedAt;
        break;
      case "server.hostname.set": {
        const payload = parseHostnamePayload(message.payload);
        result = await handleHostname(payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = (/* @__PURE__ */ new Date()).toISOString();
        break;
      }
      case "server.reboot": {
        parseRebootPayload(message.payload);
        result = await handleReboot(message.payload, daemonReceivedAt);
        ok = true;
        daemonRespondedAt = (/* @__PURE__ */ new Date()).toISOString();
        break;
      }
      default:
        ok = false;
        error = `Unknown command type: ${message.commandType}`;
        break;
    }
    sendOutcome(ws, {
      type: "command-outcome",
      id: message.id,
      ok,
      result: ok ? result : void 0,
      error: error ? sanitizeError(error) : void 0,
      at: daemonRespondedAt,
      daemonReceivedAt,
      daemonRespondedAt
    });
  } catch (err) {
    const daemonRespondedAt = (/* @__PURE__ */ new Date()).toISOString();
    sendOutcome(ws, {
      type: "command-outcome",
      id: message.id,
      ok: false,
      error: sanitizeError(err),
      at: daemonRespondedAt,
      daemonReceivedAt,
      daemonRespondedAt
    });
  }
}
var init_command_router = __esm({
  "src/instance/commands/command-router.ts"() {
    init_contracts();
    init_hostname();
    init_ping();
    init_reboot();
  }
});

// src/server-addresses.ts
function isLoopbackIpv4(address) {
  return address.startsWith("127.");
}
function isLoopbackIpv6(address) {
  const lower = address.toLowerCase();
  return lower === "::1" || lower === "0:0:0:0:0:0:0:1";
}
function isLinkLocalIpv4(address) {
  return address.startsWith("169.254.");
}
function isLinkLocalIpv6(address) {
  return address.toLowerCase().startsWith("fe80:");
}
function isPhysicalInterface(name) {
  return !VIRTUAL_INTERFACE.some((pattern) => pattern.test(name));
}
function parseIpv4Octets(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  return octets;
}
function isUsableIpv4(address) {
  if (isLoopbackIpv4(address) || isLinkLocalIpv4(address)) return false;
  const octets = parseIpv4Octets(address);
  if (!octets) return false;
  const [a] = octets;
  return a > 0 && a < 224;
}
function isPrivateIpv4(address) {
  const octets = parseIpv4Octets(address);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}
function isPublicIpv4(address) {
  return isUsableIpv4(address) && !isPrivateIpv4(address);
}
function isUsableIpv6(address) {
  const lower = address.toLowerCase().split("%")[0];
  if (isLoopbackIpv6(lower) || isLinkLocalIpv6(lower)) return false;
  if (lower.startsWith("ff")) return false;
  return true;
}
function isPrivateIpv6(address) {
  const lower = address.toLowerCase().split("%")[0];
  return lower.startsWith("fc") || lower.startsWith("fd");
}
function isPublicIpv6(address) {
  const lower = address.toLowerCase().split("%")[0];
  if (!isUsableIpv6(lower) || isPrivateIpv6(lower)) return false;
  const first = lower.replace(/^::/, "")[0];
  return first === "2" || first === "3";
}
function collectServerAddresses() {
  const privateIpv4 = /* @__PURE__ */ new Set();
  const privateIpv6 = /* @__PURE__ */ new Set();
  const publicIpv4 = /* @__PURE__ */ new Set();
  const publicIpv6 = /* @__PURE__ */ new Set();
  for (const addr of Deno.networkInterfaces()) {
    if (!isPhysicalInterface(addr.name)) continue;
    if (addr.family === "IPv4") {
      if (isPrivateIpv4(addr.address)) privateIpv4.add(addr.address);
      else if (isPublicIpv4(addr.address)) publicIpv4.add(addr.address);
      continue;
    }
    if (isPrivateIpv6(addr.address)) privateIpv6.add(addr.address);
    else if (isPublicIpv6(addr.address)) publicIpv6.add(addr.address);
  }
  return {
    privateIpv4: [
      ...privateIpv4
    ].sort(),
    privateIpv6: [
      ...privateIpv6
    ].sort(),
    publicIpv4: [
      ...publicIpv4
    ].sort(),
    publicIpv6: [
      ...publicIpv6
    ].sort()
  };
}
var VIRTUAL_INTERFACE;
var init_server_addresses = __esm({
  "src/server-addresses.ts"() {
    VIRTUAL_INTERFACE = [
      /^lo$/,
      /^docker\d*$/,
      /^br-/,
      /^veth/,
      /^virbr/,
      /^tun\d*$/,
      /^tap\d*$/,
      /^wg\d*$/,
      /^cni/,
      /^flannel/,
      /^cali/,
      /^kube-/,
      /^tailscale/,
      /^ifb/,
      /^dummy/
    ];
  }
});

// src/dev-sync-apply.ts
function newDevSyncState(totalChunks) {
  return {
    chunks: new Array(totalChunks).fill(""),
    totalChunks
  };
}
function isColocatedDevDaemonHost() {
  const flag = Deno.env.get("TURBOPANEL_DEV_INSTANCE")?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}
async function pathExists2(path) {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
async function replaceDaemonSourceTree(staging) {
  for (const name of HOST_LOCAL_ARTIFACTS) {
    const current = join3(DAEMON_ROOT, name);
    if (!await pathExists2(current)) continue;
    const target = join3(staging, name);
    if (await pathExists2(target)) {
      await Deno.remove(target, {
        recursive: true
      });
    }
    await Deno.rename(current, target);
  }
  try {
    const mode = (await Deno.stat(DAEMON_ROOT)).mode;
    if (mode !== null) await Deno.chmod(staging, mode);
  } catch {
  }
  const backup = `${DAEMON_ROOT}.dev-sync-old`;
  await Deno.remove(backup, {
    recursive: true
  }).catch(() => {
  });
  await Deno.rename(DAEMON_ROOT, backup);
  try {
    await Deno.rename(staging, DAEMON_ROOT);
  } catch (err) {
    await Deno.rename(backup, DAEMON_ROOT).catch(() => {
    });
    throw err;
  }
  await Deno.remove(backup, {
    recursive: true
  }).catch(() => {
  });
}
async function applyDevSyncTarball(bytes) {
  if (isColocatedDevDaemonHost()) {
    throw new Error(COLOCATED_DEV_SYNC_REFUSED_REASON);
  }
  const stableCwd = dirname3(DAEMON_ROOT);
  try {
    Deno.chdir(stableCwd);
  } catch {
    Deno.chdir("/");
  }
  const tmp = await Deno.makeTempFile({
    suffix: ".tgz"
  });
  const staging = join3(dirname3(DAEMON_ROOT), ".daemon-dev-sync-staging");
  try {
    await Deno.writeFile(tmp, bytes);
    await Deno.remove(staging, {
      recursive: true
    }).catch(() => {
    });
    await Deno.mkdir(staging, {
      recursive: true
    });
    const command = new Deno.Command("tar", {
      args: [
        "-xzf",
        tmp,
        "-C",
        staging
      ],
      cwd: stableCwd,
      stdout: "piped",
      stderr: "piped"
    });
    const out = await command.output();
    if (!out.success) {
      throw new Error(`tar extract failed: ${new TextDecoder().decode(out.stderr).trim()}`);
    }
    if (!await pathExists2(join3(staging, "main.ts"))) {
      throw new Error("dev-sync archive did not contain main.ts");
    }
    await replaceDaemonSourceTree(staging);
    try {
      const cache = new Deno.Command(Deno.execPath(), {
        args: [
          "cache",
          "main.ts"
        ],
        cwd: DAEMON_ROOT,
        stdout: "piped",
        stderr: "piped"
      });
      const cacheOut = await cache.output();
      if (!cacheOut.success) {
        logWarn("dev-sync", "deno cache warning:", new TextDecoder().decode(cacheOut.stderr).trim());
      }
    } catch (err) {
      logWarn("dev-sync", "deno cache skipped:", err instanceof Error ? err.message : String(err));
    }
  } finally {
    await Deno.remove(tmp).catch(() => {
    });
    await Deno.remove(staging, {
      recursive: true
    }).catch(() => {
    });
  }
}
var HOST_LOCAL_ARTIFACTS, COLOCATED_DEV_SYNC_REFUSED_REASON;
var init_dev_sync_apply = __esm({
  "src/dev-sync-apply.ts"() {
    init_mod();
    init_paths();
    init_logger();
    HOST_LOCAL_ARTIFACTS = [
      ".env",
      ".git",
      ".github",
      "state",
      "logs",
      "cloudflared",
      "server.id",
      "server-key.json",
      "server-key-id"
    ];
    COLOCATED_DEV_SYNC_REFUSED_REASON = "dev-sync refused on co-located development daemon \u2014 edit the local checkout directly";
  }
});

// src/instance/public-urls-env.ts
function resolveInstanceConfigDir(env = Deno.env.toObject()) {
  return resolveLayout(env).instanceConfigDir;
}
function resolveInstanceRuntimeEnvPath(env = Deno.env.toObject()) {
  return join3(resolveInstanceConfigDir(env), RUNTIME_ENV_FILENAME);
}
async function readEnvFileMeta(envPath) {
  try {
    const stat = await Deno.stat(envPath);
    return {
      mode: stat.mode ?? DEFAULT_ENV_MODE,
      uid: stat.uid ?? void 0,
      gid: stat.gid ?? void 0
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}
async function chownFileOwner(path, uid, gid) {
  try {
    await Deno.chown(path, uid, gid);
    return;
  } catch (err) {
    if (!(err instanceof Deno.errors.PermissionDenied)) throw err;
  }
  const result = await new Deno.Command("sudo", {
    args: [
      "chown",
      `${uid}:${gid}`,
      path
    ],
    stdout: "piped",
    stderr: "piped"
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `sudo chown ${uid}:${gid} failed for ${path}`);
  }
}
async function ensureWriteTmpDir(configDir) {
  const tmpDir = join3(configDir, ".write-tmp");
  await Deno.mkdir(tmpDir, {
    recursive: true,
    mode: 448
  });
  return tmpDir;
}
async function removeTempFile(path) {
  if (!path) return;
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}
async function writeEnvFileAtomic(envPath, content, meta) {
  const configDir = dirname3(envPath);
  await Deno.mkdir(configDir, {
    recursive: true,
    mode: 488
  });
  const tmpDir = await ensureWriteTmpDir(configDir);
  const tmpPath = join3(tmpDir, `write-${crypto.randomUUID()}`);
  const mode = meta?.mode ?? DEFAULT_ENV_MODE;
  let tmpCreated = tmpPath;
  try {
    await Deno.writeTextFile(tmpPath, content, {
      mode
    });
    if (meta?.uid !== void 0 && meta?.gid !== void 0) {
      await chownFileOwner(tmpPath, meta.uid, meta.gid);
    }
    await Deno.rename(tmpPath, envPath);
    tmpCreated = null;
  } finally {
    await removeTempFile(tmpCreated);
  }
}
async function upsertPublicUrlsInEnv(urls, options = {}) {
  const envPath = options.runtimeEnvPath ?? resolveInstanceRuntimeEnvPath(options.env);
  const meta = await readEnvFileMeta(envPath);
  let content = "";
  try {
    content = await Deno.readTextFile(envPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const newLine = `${PUBLIC_URLS_KEY}${urls.join(",")}`;
  const lines = content.length > 0 ? content.split("\n") : [];
  let found = false;
  const updated = lines.map((line) => {
    if (line.startsWith(PUBLIC_URLS_KEY)) {
      found = true;
      return newLine;
    }
    return line;
  });
  if (!found) {
    updated.push(newLine);
  }
  let result = updated.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  await writeEnvFileAtomic(envPath, result, meta);
}
var RUNTIME_ENV_FILENAME, PUBLIC_URLS_KEY, DEFAULT_ENV_MODE;
var init_public_urls_env = __esm({
  "src/instance/public-urls-env.ts"() {
    init_mod();
    init_layout();
    RUNTIME_ENV_FILENAME = "runtime.env";
    PUBLIC_URLS_KEY = "TURBOPANEL_PUBLIC_URLS=";
    DEFAULT_ENV_MODE = 416;
  }
});

// src/instance/public-urls-apply.ts
function resolveInstanceDir(env = Deno.env.toObject()) {
  return resolveLayout(env).instanceDir;
}
async function runInstanceCertsApply(instanceDir, urls) {
  const args = [
    "-e",
    `turbopanel_instance_dir=${instanceDir}`,
    "-e",
    `turbopanel_public_urls=${urls.join(",")}`,
    ...devOwnershipPlaybookExtraArgs()
  ];
  await runLocalPlaybook(INSTANCE_CERTS_APPLY_PLAYBOOK, args);
}
async function applyPublicUrls(urls) {
  const instanceDir = resolveInstanceDir();
  await upsertPublicUrlsInEnv(urls);
  await runInstanceCertsApply(instanceDir, urls);
}
var init_public_urls_apply = __esm({
  "src/instance/public-urls-apply.ts"() {
    init_ansible();
    init_paths();
    init_layout();
    init_public_urls_env();
    init_public_urls_env();
  }
});

// src/orchestration/cloudflared.ts
async function fileExists7(path) {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
async function installedCloudflaredVersion(bin) {
  if (!await fileExists7(bin)) return null;
  try {
    const command = new Deno.Command(bin, {
      args: [
        "--version"
      ],
      stdout: "piped",
      stderr: "null"
    });
    const { success, stdout } = await command.output();
    if (!success) return null;
    const match = new TextDecoder().decode(stdout).match(/version\s+(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
async function fetchBytes2(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
async function repointCurrent(version = CLOUDFLARED_VERSION) {
  try {
    await Deno.remove(CLOUDFLARED_CURRENT_DIR);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logWarn("cloudflared", "could not replace current symlink:", err);
      return;
    }
  }
  try {
    await Deno.symlink(cloudflaredDir(version), CLOUDFLARED_CURRENT_DIR);
  } catch (err) {
    logWarn("cloudflared", "could not create current symlink:", err);
  }
}
async function ensureCloudflared() {
  const bin = cloudflaredBin();
  const current = await installedCloudflaredVersion(bin);
  if (current === CLOUDFLARED_VERSION) {
    logInfo("cloudflared", `${CLOUDFLARED_VERSION} already installed`);
    await repointCurrent();
    return bin;
  }
  const asset = resolveCloudflaredAsset();
  const url = cloudflaredDownloadUrl(asset);
  logInfo("cloudflared", `downloading ${CLOUDFLARED_VERSION} from ${url}`);
  const bytes = await fetchBytes2(url);
  await Deno.mkdir(cloudflaredDir(), {
    recursive: true
  });
  await Deno.writeFile(bin, bytes);
  await Deno.chmod(bin, 493);
  const version = await installedCloudflaredVersion(bin);
  if (version !== CLOUDFLARED_VERSION) {
    throw new Error(`cloudflared install verification failed: expected ${CLOUDFLARED_VERSION}, got ${version ?? "none"}`);
  }
  await repointCurrent();
  logInfo("cloudflared", `${CLOUDFLARED_VERSION} installed at ${bin}`);
  return bin;
}
var init_cloudflared = __esm({
  "src/orchestration/cloudflared.ts"() {
    init_paths();
    init_logger();
  }
});

// src/tunnels.ts
function delay2(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
async function readTunnelConfigs() {
  const configs = [];
  try {
    for await (const entry of Deno.readDir(TUNNELS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".token")) continue;
      const token = (await Deno.readTextFile(join3(TUNNELS_DIR, entry.name))).trim();
      if (!token) {
        logWarn("tunnels", `${entry.name} is empty; skipping`);
        continue;
      }
      configs.push({
        name: entry.name.replace(/\.token$/, ""),
        token
      });
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return configs;
}
function superviseTunnel(bin, config, signal) {
  void (async () => {
    while (!signal.aborted) {
      logInfo("tunnels", `starting tunnel "${config.name}"`);
      const command = new Deno.Command(bin, {
        args: [
          "--no-autoupdate",
          "tunnel",
          "run",
          "--token",
          config.token
        ],
        stdout: "inherit",
        stderr: "inherit"
      });
      const child = command.spawn();
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
        }
      };
      signal.addEventListener("abort", onAbort, {
        once: true
      });
      const status = await child.status;
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) break;
      logWarn("tunnels", `tunnel "${config.name}" exited (code ${status.code}); restarting in 5s`);
      await delay2(5e3);
    }
  })();
}
async function launchTunnels() {
  runAbort?.abort();
  if (!parentSignal || parentSignal.aborted) return;
  const ac = new AbortController();
  runAbort = ac;
  parentSignal.addEventListener("abort", () => ac.abort(), {
    once: true
  });
  const configs = await readTunnelConfigs();
  if (configs.length === 0) {
    logInfo("tunnels", `no tunnel tokens in ${TUNNELS_DIR}; skipping`);
    return;
  }
  let bin;
  try {
    bin = await ensureCloudflared();
  } catch (err) {
    logError("tunnels", "cloudflared install failed; tunnels disabled:", err instanceof Error ? err.message : err);
    return;
  }
  logInfo("tunnels", `supervising ${configs.length} tunnel(s)`);
  for (const config of configs) {
    superviseTunnel(bin, config, ac.signal);
  }
}
async function startTunnels(signal) {
  if (!CLOUDFLARE_TUNNELS_ENABLED) {
    logInfo("tunnels", "Cloudflare tunnels disabled; skipping");
    return;
  }
  parentSignal = signal;
  await launchTunnels();
}
async function writeInstanceTunnelToken(token) {
  if (!CLOUDFLARE_TUNNELS_ENABLED) {
    logInfo("tunnels", "Cloudflare tunnels disabled; ignoring tunnel token");
    return;
  }
  const trimmed = token.trim();
  await Deno.mkdir(TUNNELS_DIR, {
    recursive: true
  });
  const path = join3(TUNNELS_DIR, `${INSTANCE_TUNNEL_NAME}.token`);
  if (!trimmed) {
    await Deno.remove(path).catch(() => {
    });
    logInfo("tunnels", "instance tunnel token cleared");
  } else {
    await Deno.writeTextFile(path, `${trimmed}
`);
    await Deno.chmod(path, 384).catch(() => {
    });
    logInfo("tunnels", "instance tunnel token updated");
  }
  await launchTunnels();
}
var CLOUDFLARE_TUNNELS_ENABLED, INSTANCE_TUNNEL_NAME, parentSignal, runAbort;
var init_tunnels = __esm({
  "src/tunnels.ts"() {
    init_mod();
    init_cloudflared();
    init_paths();
    init_logger();
    CLOUDFLARE_TUNNELS_ENABLED = false;
    INSTANCE_TUNNEL_NAME = "instance";
    parentSignal = null;
    runAbort = null;
  }
});

// deno:https://jsr.io/@std/encoding/1.0.10/_common64.ts
function calcSizeBase64(originalSize) {
  return ((originalSize + 2) / 3 | 0) * 4;
}
function encode2(buffer, i, o, alphabet6, padding4) {
  i += 2;
  for (; i < buffer.length; i += 3) {
    const x = buffer[i - 2] << 16 | buffer[i - 1] << 8 | buffer[i];
    buffer[o++] = alphabet6[x >> 18];
    buffer[o++] = alphabet6[x >> 12 & 63];
    buffer[o++] = alphabet6[x >> 6 & 63];
    buffer[o++] = alphabet6[x & 63];
  }
  switch (i) {
    case buffer.length + 1: {
      const x = buffer[i - 2] << 16;
      buffer[o++] = alphabet6[x >> 18];
      buffer[o++] = alphabet6[x >> 12 & 63];
      buffer[o++] = padding4;
      buffer[o++] = padding4;
      break;
    }
    case buffer.length: {
      const x = buffer[i - 2] << 16 | buffer[i - 1] << 8;
      buffer[o++] = alphabet6[x >> 18];
      buffer[o++] = alphabet6[x >> 12 & 63];
      buffer[o++] = alphabet6[x >> 6 & 63];
      buffer[o++] = padding4;
      break;
    }
  }
  return o;
}
function decode2(buffer, i, o, alphabet6, padding4) {
  for (let x = buffer.length - 2; x < buffer.length; ++x) {
    if (buffer[x] === padding4) {
      for (let y = x + 1; y < buffer.length; ++y) {
        if (buffer[y] !== padding4) {
          throw new TypeError(`Cannot decode input as base64: Invalid character (${String.fromCharCode(buffer[y])})`);
        }
      }
      buffer = buffer.subarray(0, x);
      break;
    }
  }
  if ((buffer.length - o) % 4 === 1) {
    throw new RangeError(`Cannot decode input as base64: Length (${buffer.length - o}), excluding padding, must not have a remainder of 1 when divided by 4`);
  }
  i += 3;
  for (; i < buffer.length; i += 4) {
    const x = getByte(buffer[i - 3], alphabet6) << 18 | getByte(buffer[i - 2], alphabet6) << 12 | getByte(buffer[i - 1], alphabet6) << 6 | getByte(buffer[i], alphabet6);
    buffer[o++] = x >> 16;
    buffer[o++] = x >> 8 & 255;
    buffer[o++] = x & 255;
  }
  switch (i) {
    case buffer.length + 1: {
      const x = getByte(buffer[i - 3], alphabet6) << 18 | getByte(buffer[i - 2], alphabet6) << 12;
      buffer[o++] = x >> 16;
      break;
    }
    case buffer.length: {
      const x = getByte(buffer[i - 3], alphabet6) << 18 | getByte(buffer[i - 2], alphabet6) << 12 | getByte(buffer[i - 1], alphabet6) << 6;
      buffer[o++] = x >> 16;
      buffer[o++] = x >> 8 & 255;
      break;
    }
  }
  return o;
}
function getByte(char, alphabet6) {
  const byte = alphabet6[char] ?? 64;
  if (byte === 64) {
    throw new TypeError(`Cannot decode input as base64: Invalid character (${String.fromCharCode(char)})`);
  }
  return byte;
}
var padding, alphabet3, rAlphabet3;
var init_common64 = __esm({
  "deno:https://jsr.io/@std/encoding/1.0.10/_common64.ts"() {
    padding = "=".charCodeAt(0);
    alphabet3 = {
      base64: new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"),
      base64url: new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    };
    rAlphabet3 = {
      base64: new Uint8Array(128).fill(64),
      base64url: new Uint8Array(128).fill(64)
    };
    alphabet3.base64.forEach((byte, i) => rAlphabet3.base64[byte] = i);
    alphabet3.base64url.forEach((byte, i) => rAlphabet3.base64url[byte] = i);
  }
});

// deno:https://jsr.io/@std/encoding/1.0.10/base64url.ts
function encodeBase64Url(data) {
  if (typeof data === "string") {
    data = new TextEncoder().encode(data);
  } else if (data instanceof ArrayBuffer) data = new Uint8Array(data).slice();
  else data = data.slice();
  const [output, i] = detach(data, calcSizeBase64(data.length));
  let o = encode2(output, i, 0, alphabet4, padding2);
  o = output.indexOf(padding2, o - 2);
  return new TextDecoder().decode(o > 0 ? new Uint8Array(output.buffer.transfer(o)) : output);
}
function decodeBase64Url(b64url) {
  const output = new TextEncoder().encode(b64url);
  return new Uint8Array(output.buffer.transfer(decode2(output, 0, 0, rAlphabet4, padding2)));
}
var padding2, alphabet4, rAlphabet4;
var init_base64url = __esm({
  "deno:https://jsr.io/@std/encoding/1.0.10/base64url.ts"() {
    init_common64();
    init_common_detach();
    padding2 = "=".charCodeAt(0);
    alphabet4 = new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");
    rAlphabet4 = new Uint8Array(128).fill(64);
    alphabet4.forEach((byte, i) => rAlphabet4[byte] = i);
  }
});

// src/crypto/keys.ts
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isDaemonKeyFile(value) {
  if (!isObject(value)) return false;
  if (value.algorithm !== "Ed25519") return false;
  if (typeof value.keyId !== "string") return false;
  if (typeof value.createdAt !== "string") return false;
  if (!isObject(value.publicJwk)) return false;
  if (!isObject(value.privateJwk)) return false;
  return true;
}
async function generateDaemonKeypair() {
  const keyPair = await crypto.subtle.generateKey({
    name: "Ed25519"
  }, true, [
    "sign",
    "verify"
  ]);
  if (!("publicKey" in keyPair) || !("privateKey" in keyPair)) {
    throw new TypeError("Expected an Ed25519 CryptoKeyPair");
  }
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    algorithm: "Ed25519",
    keyId: crypto.randomUUID(),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    publicJwk,
    privateJwk
  };
}
async function computePublicKeyFingerprint(publicJwk) {
  const canonical = {
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x
  };
  const canonicalJson = JSON.stringify(canonical);
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(canonicalJson));
  return encodeHex(new Uint8Array(digest));
}
function buildEnrollmentPayload(params) {
  return `turbopanel-daemon-enroll-v1
${params.challengeId}
${params.nonce}
${params.licenseId}
${params.machineId}
${params.hostname}
${params.publicKeyFingerprint}`;
}
function buildAuthPayload(params) {
  return `turbopanel-daemon-auth-v1
${params.challengeId}
${params.nonce}
${params.serverId}
${params.keyId}
${params.machineId}
${params.hostname}`;
}
async function signChallenge(privateJwk, payload) {
  const key = await crypto.subtle.importKey("jwk", privateJwk, {
    name: "Ed25519"
  }, false, [
    "sign"
  ]);
  const signature = await crypto.subtle.sign({
    name: "Ed25519"
  }, key, textEncoder.encode(payload));
  return encodeBase64Url(new Uint8Array(signature));
}
async function loadDaemonKeyFile(path) {
  try {
    const content = await Deno.readTextFile(path);
    const parsed = JSON.parse(content);
    return isDaemonKeyFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
async function saveDaemonKeyFile(path, keyFile) {
  const directoryPath = dirname3(path);
  await Deno.mkdir(directoryPath, {
    recursive: true
  });
  const content = JSON.stringify(keyFile);
  await Deno.writeTextFile(path, content, {
    mode: 384
  });
}
var textEncoder;
var init_keys = __esm({
  "src/crypto/keys.ts"() {
    init_base64url();
    init_hex();
    init_mod();
    textEncoder = new TextEncoder();
  }
});

// src/instance/api-client.ts
var DaemonApiError, DaemonApiClient;
var init_api_client = __esm({
  "src/instance/api-client.ts"() {
    init_paths2();
    DaemonApiError = class extends Error {
      status;
      constructor(status, message) {
        super(message);
        this.name = "DaemonApiError";
        this.status = status;
      }
    };
    DaemonApiClient = class {
      #options;
      constructor(options) {
        this.#options = options;
      }
      async getEnrollmentChallenge() {
        return await this.#requestJson("/api/daemon/v1/auth/challenge", {
          method: "POST",
          body: JSON.stringify({})
        });
      }
      async getAuthChallenge(params) {
        return await this.#requestJson("/api/daemon/v1/auth/challenge", {
          method: "POST",
          body: JSON.stringify(params)
        });
      }
      async enroll(params) {
        return await this.#requestJson("/api/daemon/v1/enroll", {
          method: "POST",
          body: JSON.stringify(params)
        });
      }
      async createSession(params) {
        return await this.#requestJson("/api/daemon/v1/auth/session", {
          method: "POST",
          body: JSON.stringify(params)
        });
      }
      async #requestJson(path, init, options = {}) {
        const response = await this.#request(path, init, options);
        try {
          return await response.json();
        } catch {
          throw new DaemonApiError(response.status, "Invalid JSON response");
        }
      }
      async #request(path, init, options = {}) {
        const headers = new Headers(init.headers);
        headers.set("content-type", "application/json");
        if (options.auth) {
          const token = await this.#options.getToken();
          headers.set("authorization", `Bearer ${token}`);
        }
        let response = await this.#fetch(path, {
          ...init,
          headers
        });
        if (options.auth && response.status === 401) {
          const refreshedToken = await this.#options.getToken({
            forceRefresh: true
          });
          const retryHeaders = new Headers(init.headers);
          retryHeaders.set("content-type", "application/json");
          retryHeaders.set("authorization", `Bearer ${refreshedToken}`);
          response = await this.#fetch(path, {
            ...init,
            headers: retryHeaders
          });
        }
        if (!response.ok) {
          throw await this.#toApiError(response);
        }
        return response;
      }
      async #toApiError(response) {
        try {
          const body = await response.json();
          if (typeof body.error === "string" && body.error.trim().length > 0) {
            return new DaemonApiError(response.status, body.error);
          }
        } catch {
        }
        return new DaemonApiError(response.status, `HTTP ${response.status}`);
      }
      #fetch(path, init) {
        const url = instanceUrl(this.#options.config, path);
        if (this.#options.httpClient) {
          return fetch(url, {
            ...init,
            client: this.#options.httpClient
          });
        }
        return fetch(url, init);
      }
    };
  }
});

// src/instance/token-manager.ts
function parseJwtExpiryMs(token) {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("invalid JWT format");
  let payloadBytes;
  try {
    payloadBytes = decodeBase64Url(parts[1]);
  } catch {
    throw new Error("invalid JWT payload encoding");
  }
  const payloadText = new TextDecoder().decode(payloadBytes);
  const payload = JSON.parse(payloadText);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("invalid JWT exp claim");
  }
  return payload.exp * 1e3;
}
function delay3(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
var DEFAULT_REFRESH_EARLY_MS, DaemonTokenManager;
var init_token_manager = __esm({
  "src/instance/token-manager.ts"() {
    init_base64url();
    init_keys();
    DEFAULT_REFRESH_EARLY_MS = 6e4;
    DaemonTokenManager = class {
      #options;
      #refreshEarlyMs;
      #token;
      #expiresAtMs = 0;
      #refreshPromise;
      constructor(options) {
        this.#options = options;
        this.#refreshEarlyMs = options.refreshEarlyMs ?? DEFAULT_REFRESH_EARLY_MS;
      }
      async getToken(options = {}) {
        if (!options.forceRefresh && this.#token && this.#expiresAtMs - Date.now() >= this.#refreshEarlyMs) {
          return this.#token;
        }
        await this.refresh();
        if (!this.#token) {
          throw new Error("token refresh did not produce a token");
        }
        return this.#token;
      }
      refresh() {
        if (this.#refreshPromise) return this.#refreshPromise;
        this.#refreshPromise = this.#refreshWithRetry();
        return this.#refreshPromise;
      }
      stop() {
      }
      async #refreshWithRetry() {
        try {
          await this.#doRefresh();
        } catch (firstError) {
          await delay3(2e3);
          try {
            await this.#doRefresh();
          } catch {
            throw firstError;
          }
        } finally {
          this.#refreshPromise = void 0;
        }
      }
      async #doRefresh() {
        const challenge = await this.#options.apiClient.getAuthChallenge({
          serverId: this.#options.serverId,
          keyId: this.#options.keyId
        });
        const payload = buildAuthPayload({
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          serverId: this.#options.serverId,
          keyId: this.#options.keyId,
          machineId: this.#options.machineId ?? "",
          hostname: this.#options.hostname
        });
        const signature = await signChallenge(this.#options.keyFile.privateJwk, payload);
        const session = await this.#options.apiClient.createSession({
          serverId: this.#options.serverId,
          keyId: this.#options.keyId,
          challengeId: challenge.challengeId,
          signature,
          machineId: this.#options.machineId,
          hostname: this.#options.hostname,
          at: (/* @__PURE__ */ new Date()).toISOString()
        });
        this.#token = session.token;
        this.#expiresAtMs = parseJwtExpiryMs(session.token);
      }
    };
  }
});

// src/instance/enroll.ts
async function enrollDaemon(params) {
  const challenge = await params.apiClient.getEnrollmentChallenge();
  const enrollmentKeyFile = await generateDaemonKeypair();
  const fingerprint = await computePublicKeyFingerprint(enrollmentKeyFile.publicJwk);
  const payload = buildEnrollmentPayload({
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    licenseId: params.licenseId,
    machineId: params.machineId ?? "",
    hostname: params.hostname,
    publicKeyFingerprint: fingerprint
  });
  const signature = await signChallenge(enrollmentKeyFile.privateJwk, payload);
  const enrollment = await params.apiClient.enroll({
    licenseId: params.licenseId,
    licenseToken: params.licenseToken,
    machineId: params.machineId,
    hostname: params.hostname,
    publicJwk: enrollmentKeyFile.publicJwk,
    challengeId: challenge.challengeId,
    signature
  });
  await Deno.mkdir(params.stateDir, {
    recursive: true
  });
  await saveDaemonKeyFile(join3(params.stateDir, SERVER_KEY_FILE2), enrollmentKeyFile);
  await Deno.writeTextFile(join3(params.stateDir, SERVER_ID_FILE), `${enrollment.serverId}
`);
  await Deno.writeTextFile(join3(params.stateDir, KEY_ID_FILE), `${enrollment.keyId}
`);
  return {
    keyFile: enrollmentKeyFile,
    serverId: enrollment.serverId,
    keyId: enrollment.keyId
  };
}
var SERVER_ID_FILE, SERVER_KEY_FILE2, KEY_ID_FILE;
var init_enroll = __esm({
  "src/instance/enroll.ts"() {
    init_mod();
    init_keys();
    SERVER_ID_FILE = "server.id";
    SERVER_KEY_FILE2 = "server-key.json";
    KEY_ID_FILE = "server-key-id";
  }
});

// deno:https://jsr.io/@std/encoding/1.0.10/base64.ts
function decodeBase64(b64) {
  const output = new TextEncoder().encode(b64);
  return new Uint8Array(output.buffer.transfer(decode2(output, 0, 0, rAlphabet5, padding3)));
}
var padding3, alphabet5, rAlphabet5;
var init_base64 = __esm({
  "deno:https://jsr.io/@std/encoding/1.0.10/base64.ts"() {
    init_common64();
    init_common_detach();
    padding3 = "=".charCodeAt(0);
    alphabet5 = new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
    rAlphabet5 = new Uint8Array(128).fill(64);
    alphabet5.forEach((byte, i) => rAlphabet5[byte] = i);
  }
});

// src/instance/idle-presence.ts
function sanitizeForLog(value) {
  if (value instanceof Error) return value.message.replaceAll("\n", "_");
  return String(value).replaceAll("\n", "_");
}
var IDLE_PRESENCE_MS, CELL_PING_MESSAGE, IdlePresence;
var init_idle_presence = __esm({
  "src/instance/idle-presence.ts"() {
    init_build_info();
    init_logger();
    IDLE_PRESENCE_MS = 6e4;
    CELL_PING_MESSAGE = '{"type":"ping"}';
    IdlePresence = class {
      #serverId;
      #idleCheckIntervalMs;
      #idleThresholdMs;
      #minPresenceIntervalMs;
      #ws;
      #idleTimer;
      #lastActivityAt = Date.now();
      #lastPresenceSendAt = 0;
      #lastAgentCommit;
      constructor(options) {
        this.#serverId = options.serverId;
        this.#idleCheckIntervalMs = options.idleCheckIntervalMs ?? IDLE_PRESENCE_MS;
        this.#idleThresholdMs = options.idleThresholdMs ?? IDLE_PRESENCE_MS;
        this.#minPresenceIntervalMs = options.minPresenceIntervalMs ?? this.#idleCheckIntervalMs;
      }
      get lastActivityAt() {
        return this.#lastActivityAt;
      }
      touchActivity() {
        this.#lastActivityAt = Date.now();
      }
      attach(ws) {
        this.detach();
        this.#ws = ws;
        this.#lastActivityAt = Date.now();
        this.#sendHello();
        this.#idleTimer = setInterval(() => {
          this.#maybeSendIdleHeartbeat();
        }, this.#idleCheckIntervalMs);
      }
      detach() {
        if (this.#idleTimer) {
          clearInterval(this.#idleTimer);
          this.#idleTimer = void 0;
        }
        this.#ws = void 0;
      }
      #sendHello() {
        const ws = this.#ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const agent = getBuildInfo();
        this.#lastAgentCommit = agent.commit;
        try {
          ws.send(JSON.stringify({
            type: "hello",
            at: (/* @__PURE__ */ new Date()).toISOString(),
            agent
          }));
          this.#lastActivityAt = Date.now();
        } catch (err) {
          logWarn("instance", "hello send failed:", sanitizeForLog(err));
        }
      }
      #maybeSendIdleHeartbeat() {
        if (Date.now() - this.#lastActivityAt < this.#idleThresholdMs) return;
        if (this.#lastPresenceSendAt > 0 && Date.now() - this.#lastPresenceSendAt < this.#minPresenceIntervalMs) {
          return;
        }
        this.#sendCellPing();
        const agent = getBuildInfo();
        if (agent.commit !== this.#lastAgentCommit) {
          this.#sendIdleHeartbeat();
        }
      }
      #sendCellPing() {
        const ws = this.#ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(CELL_PING_MESSAGE);
          const now = Date.now();
          this.#lastActivityAt = now;
          this.#lastPresenceSendAt = now;
        } catch (err) {
          logWarn("instance", "cell ping send failed:", sanitizeForLog(err));
        }
      }
      #sendIdleHeartbeat() {
        const ws = this.#ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const agent = getBuildInfo();
        const payload = {
          type: "heartbeat",
          at: (/* @__PURE__ */ new Date()).toISOString()
        };
        if (agent.commit !== this.#lastAgentCommit) {
          payload.agent = agent;
          this.#lastAgentCommit = agent.commit;
        }
        try {
          ws.send(JSON.stringify(payload));
          this.#lastActivityAt = Date.now();
        } catch (err) {
          logWarn("instance", "idle heartbeat send failed:", sanitizeForLog(err));
        }
      }
    };
  }
});

// src/update/config.ts
function resolveUpdateChannelConfig(env = Deno.env.toObject()) {
  const raw = env.TURBOPANEL_UPDATE_CHANNEL?.trim();
  const value = raw || "trunk";
  if (!VALID_CHANNELS.has(value)) {
    const valid = [
      ...VALID_CHANNELS
    ].join(", ");
    throw new Error(`Invalid TURBOPANEL_UPDATE_CHANNEL: "${value}". Valid values: ${valid}`);
  }
  return {
    app: "daemon",
    channel: value
  };
}
var VALID_CHANNELS;
var init_config = __esm({
  "src/update/config.ts"() {
    VALID_CHANNELS = /* @__PURE__ */ new Set([
      "trunk",
      "edge",
      "canary",
      "rc",
      "release"
    ]);
  }
});

// src/update/errors.ts
var MissingChannelError, UnsupportedSchemaVersionError, MalformedManifestError;
var init_errors = __esm({
  "src/update/errors.ts"() {
    MissingChannelError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "MissingChannelError";
      }
    };
    UnsupportedSchemaVersionError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "UnsupportedSchemaVersionError";
      }
    };
    MalformedManifestError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "MalformedManifestError";
      }
    };
  }
});

// src/update/urls.ts
function joinPath2(base, path) {
  const normalizedBase = base.replace(/\/+$/, "");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalized}`;
}
function rootCatalogUrl(base = DL_BASE_URL) {
  return joinPath2(base, "/channels.json");
}
var DL_BASE_URL;
var init_urls = __esm({
  "src/update/urls.ts"() {
    DL_BASE_URL = "https://dl.trbp.nl";
  }
});

// src/update/validate.ts
function isObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireHttpsUrl(url, fieldName) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new MalformedManifestError(`${fieldName} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new MalformedManifestError(`${fieldName} must use HTTPS`);
  }
}
function validateArtifactEntry(entry, fieldName) {
  if (!isObject2(entry)) {
    throw new MalformedManifestError(`${fieldName} must be an object`);
  }
  if (typeof entry.url !== "string" || entry.url.trim() === "") {
    throw new MalformedManifestError(`${fieldName} missing or invalid field: url`);
  }
  requireHttpsUrl(entry.url, `${fieldName}.url`);
  if (typeof entry.sha256 !== "string" || !SHA256_HEX_RE.test(entry.sha256)) {
    throw new MalformedManifestError(`${fieldName} missing or invalid field: sha256`);
  }
  if (typeof entry.size !== "number" || !Number.isFinite(entry.size) || entry.size <= 0) {
    throw new MalformedManifestError(`${fieldName} missing or invalid field: size`);
  }
  return entry;
}
function validateBinaryArtifacts(entry) {
  if (!isObject2(entry)) {
    throw new MalformedManifestError("channel.json binaryArtifacts must be an object");
  }
  const artifacts = {};
  for (const arch of LINUX_ARCHES) {
    artifacts[arch] = validateArtifactEntry(entry[arch], `channel.json binaryArtifacts.${arch}`);
  }
  return artifacts;
}
function parseRootCatalog(raw) {
  if (!isObject2(raw)) {
    throw new MalformedManifestError("channels.json root must be an object");
  }
  if (typeof raw.schema !== "number") {
    throw new MalformedManifestError("channels.json missing or invalid field: schema");
  }
  if (raw.schema !== 1) {
    throw new UnsupportedSchemaVersionError(`Unsupported channels.json schema: ${raw.schema}`);
  }
  if (typeof raw.defaultChannel !== "string") {
    throw new MalformedManifestError("channels.json missing or invalid field: defaultChannel");
  }
  if (!isObject2(raw.channels)) {
    throw new MalformedManifestError("channels.json missing or invalid field: channels");
  }
  const catalog = raw;
  for (const [channelName, channelEntry] of Object.entries(catalog.channels)) {
    if (channelEntry === void 0 || typeof channelEntry.manifestUrl !== "string" || channelEntry.manifestUrl.trim() === "") {
      throw new MalformedManifestError(`channels.json channel ${channelName} missing or invalid manifestUrl`);
    }
    requireHttpsUrl(channelEntry.manifestUrl, `channels.json channel ${channelName}.manifestUrl`);
  }
  return catalog;
}
function parseChannelManifest(raw) {
  if (!isObject2(raw)) {
    throw new MalformedManifestError("channel.json root must be an object");
  }
  if (typeof raw.schema !== "number") {
    throw new MalformedManifestError("channel.json missing or invalid field: schema");
  }
  if (raw.schema !== 1) {
    throw new UnsupportedSchemaVersionError(`Unsupported channel.json schema: ${raw.schema}`);
  }
  if (typeof raw.channel !== "string") {
    throw new MalformedManifestError("channel.json missing or invalid field: channel");
  }
  if (typeof raw.commit !== "string") {
    throw new MalformedManifestError("channel.json missing or invalid field: commit");
  }
  if (typeof raw.buildId !== "string") {
    throw new MalformedManifestError("channel.json missing or invalid field: buildId");
  }
  if (typeof raw.builtAt !== "string") {
    throw new MalformedManifestError("channel.json missing or invalid field: builtAt");
  }
  const binaryArtifacts = validateBinaryArtifacts(raw.binaryArtifacts);
  const jsFallbackArtifact = validateArtifactEntry(raw.jsFallbackArtifact, "channel.json jsFallbackArtifact");
  const orchestrationArtifact = validateArtifactEntry(raw.orchestrationArtifact, "channel.json orchestrationArtifact");
  return {
    ...raw,
    binaryArtifacts,
    jsFallbackArtifact,
    orchestrationArtifact
  };
}
var SHA256_HEX_RE, LINUX_ARCHES;
var init_validate = __esm({
  "src/update/validate.ts"() {
    init_errors();
    SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
    LINUX_ARCHES = [
      "linux-amd64",
      "linux-arm64"
    ];
  }
});

// src/update/resolver.ts
function resolveLinuxArch() {
  switch (Deno.build.arch) {
    case "x86_64":
      return "linux-amd64";
    case "aarch64":
      return "linux-arm64";
    default:
      throw new MalformedManifestError(`Unsupported CPU architecture for daemon updates: ${Deno.build.arch}`);
  }
}
async function resolveUpdate(config) {
  const catalogResponse = await fetch(rootCatalogUrl(DL_BASE_URL));
  if (!catalogResponse.ok) {
    throw new MalformedManifestError(`Failed to fetch channels.json: HTTP ${catalogResponse.status}`);
  }
  const catalog = parseRootCatalog(await catalogResponse.json());
  const channelEntry = catalog.channels[config.channel];
  if (channelEntry === void 0 || typeof channelEntry.manifestUrl !== "string" || channelEntry.manifestUrl.trim() === "") {
    throw new MissingChannelError(`Channel not found in catalog: ${config.channel}`);
  }
  const manifestResponse = await fetch(channelEntry.manifestUrl);
  if (!manifestResponse.ok) {
    throw new MalformedManifestError(`Failed to fetch channel manifest: HTTP ${manifestResponse.status}`);
  }
  const manifest = parseChannelManifest(await manifestResponse.json());
  const arch = resolveLinuxArch();
  const binaryArtifact = manifest.binaryArtifacts[arch];
  return {
    channel: manifest.channel,
    buildId: manifest.buildId,
    commit: manifest.commit,
    builtAt: manifest.builtAt,
    binaryArtifact,
    jsFallbackArtifact: manifest.jsFallbackArtifact,
    orchestrationArtifact: manifest.orchestrationArtifact,
    downloadUrl: binaryArtifact.url
  };
}
var init_resolver = __esm({
  "src/update/resolver.ts"() {
    init_errors();
    init_urls();
    init_validate();
  }
});

// src/instance/run-reconcile.ts
function isPlaintextHttpUrl(url) {
  const trimmed = url?.trim();
  return trimmed !== void 0 && trimmed.startsWith("http://");
}
function encodeLicenseArg(licenseId, licenseToken) {
  return encodeBase64Url(`${licenseId}:${licenseToken}`);
}
function resolveRunScriptUrl(config) {
  if (config.kind === "url") {
    const base = config.baseUrl.replace(/\/+$/, "");
    if (base === PRODUCTION_CONTROL_PLANE) {
      return CDN_RUN_SCRIPT;
    }
    return `${base}/run.sh`;
  }
  return CDN_RUN_SCRIPT;
}
function resolveBootstrapInsecureTls(options) {
  if (isPlaintextHttpUrl(options.runScriptUrl)) return false;
  if (options.releaseTlsInsecure === "1") return true;
  if (options.runScriptUrl === CDN_RUN_SCRIPT) return false;
  return !options.instanceCaPath?.trim();
}
function buildRunReconcileArgs(options) {
  const args = [
    "--license",
    options.licenseArg
  ];
  const instanceUrl2 = options.instanceUrl?.trim().replace(/\/+$/, "");
  if (instanceUrl2 && instanceUrl2 !== PRODUCTION_CONTROL_PLANE) {
    args.push("--host", instanceUrl2);
  }
  if (!isPlaintextHttpUrl(instanceUrl2)) {
    const caPath = options.instanceCaPath?.trim();
    if (caPath) {
      args.push("--instance-ca", caPath);
    }
    if (options.insecureTls) {
      args.push("--insecure-tls");
    }
  }
  args.push("--no-start");
  return args;
}
async function downloadRunScript(runScriptUrl, options = {}) {
  const opts = typeof options === "boolean" ? {
    insecureTls: options
  } : options;
  const curlArgs = isPlaintextHttpUrl(runScriptUrl) ? [
    "-fsSL",
    runScriptUrl
  ] : [
    "-fsSL"
  ];
  if (!isPlaintextHttpUrl(runScriptUrl)) {
    if (opts.insecureTls) {
      curlArgs.push("-k");
    } else if (opts.caPath?.trim()) {
      curlArgs.push("--cacert", opts.caPath.trim());
    }
    curlArgs.push(runScriptUrl);
  }
  const curl = await new Deno.Command("curl", {
    args: curlArgs,
    stdout: "piped",
    stderr: "piped"
  }).output();
  if (!curl.success) {
    throw new Error(new TextDecoder().decode(curl.stderr).trim() || `failed to download ${runScriptUrl}`);
  }
  const script = new TextDecoder().decode(curl.stdout);
  if (!script.trim()) {
    throw new Error(`empty run script from ${runScriptUrl}`);
  }
  return script;
}
function resolveReconcileCwd() {
  try {
    Deno.statSync(RECONCILE_CWD);
    return RECONCILE_CWD;
  } catch {
    return "/";
  }
}
async function executeRunReconcile(options) {
  const env = {
    ...Deno.env.toObject()
  };
  const channel = options.channel?.trim();
  if (channel) {
    env.TURBOPANEL_UPDATE_CHANNEL = channel;
  }
  const reconcileCwd = resolveReconcileCwd();
  try {
    Deno.chdir(reconcileCwd);
  } catch {
    Deno.chdir("/");
  }
  const command = new Deno.Command("sudo", {
    args: [
      "sh",
      "-s",
      "--",
      ...options.args
    ],
    env,
    cwd: reconcileCwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped"
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(options.script));
  await writer.close();
  const run2 = await child.output();
  if (!run2.success) {
    const stderr = new TextDecoder().decode(run2.stderr).trim();
    throw new Error(stderr || "run.sh reconcile failed");
  }
}
var PRODUCTION_CONTROL_PLANE, CDN_RUN_SCRIPT, layout3, CANONICAL_INSTANCE_CA_PATH2, RECONCILE_CWD;
var init_run_reconcile = __esm({
  "src/instance/run-reconcile.ts"() {
    init_base64url();
    init_layout();
    PRODUCTION_CONTROL_PLANE = "https://turbopanel.app";
    CDN_RUN_SCRIPT = "https://trbp.nl/run.sh";
    layout3 = resolveLayout({
      TURBOPANEL_CONFIG_DIR: readEnv("TURBOPANEL_CONFIG_DIR"),
      TURBOPANEL_DAEMON_ROOT: readEnv("TURBOPANEL_DAEMON_ROOT")
    });
    CANONICAL_INSTANCE_CA_PATH2 = layout3.instanceCaPath;
    RECONCILE_CWD = "/opt/turbopanel";
  }
});

// src/instance/client.ts
function stripLogInjection4(text) {
  return text.replaceAll("\n", "_").replaceAll("\r", "_").replaceAll("	", "_");
}
function sanitizeForLog2(value) {
  if (value instanceof Error) return stripLogInjection4(value.message);
  if (typeof value === "string") return stripLogInjection4(value);
  try {
    return stripLogInjection4(JSON.stringify(value) ?? String(value));
  } catch {
    return stripLogInjection4(String(value));
  }
}
function normalizeReconnectDelayMs(reconnectDelayMs) {
  const value = reconnectDelayMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_INITIAL_BACKOFF_MS;
  }
  return Math.min(Math.max(value, DEFAULT_INITIAL_BACKOFF_MS), DEFAULT_MAX_BACKOFF_MS);
}
function isTruthyFlag2(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
function resolveServerIdDir(env = Deno.env.toObject()) {
  return resolveServerIdentityDir(env);
}
function resolveServerIdPath() {
  return `${resolveServerIdDir()}/${SERVER_ID_FILE2}`;
}
async function readMachineId() {
  try {
    const id = await Deno.readTextFile("/etc/machine-id");
    const trimmed = id.trim();
    return trimmed.length > 0 ? trimmed : void 0;
  } catch {
    return void 0;
  }
}
async function readServerId() {
  try {
    const id = await Deno.readTextFile(resolveServerIdPath());
    const trimmed = id.trim();
    return trimmed.length > 0 ? trimmed : void 0;
  } catch {
    return void 0;
  }
}
async function readDaemonKeyFile() {
  try {
    return await loadDaemonKeyFile(resolveServerKeyPath());
  } catch {
    return null;
  }
}
async function readKeyId() {
  try {
    const keyId = await Deno.readTextFile(`${resolveServerIdDir()}/${KEY_ID_FILE2}`);
    const trimmed = keyId.trim();
    return trimmed.length > 0 ? trimmed : void 0;
  } catch {
    return void 0;
  }
}
async function readLicenseCredentials() {
  const dir = resolveServerIdDir();
  let licenseId;
  let licenseToken;
  try {
    licenseId = (await Deno.readTextFile(`${dir}/license.id`)).trim();
    licenseToken = (await Deno.readTextFile(`${dir}/license.token`)).trim();
  } catch {
    return {};
  }
  if (licenseId.length === 0 || licenseToken.length === 0) {
    return {};
  }
  return {
    licenseId,
    licenseToken
  };
}
function parseMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function isStaleDaemonIdentityError(err) {
  return err instanceof DaemonApiError && err.status === 404 && err.message === "Server key not found";
}
async function clearDaemonIdentityState(stateDir) {
  for (const file of [
    SERVER_ID_FILE2,
    SERVER_KEY_FILE3,
    KEY_ID_FILE2
  ]) {
    try {
      await Deno.remove(`${stateDir}/${file}`);
    } catch {
    }
  }
}
function delay4(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
function nextBackoffMs(current, max) {
  return Math.min(current * BACKOFF_MULTIPLIER, max);
}
function fullJitterMs(floor, ceiling) {
  const lo = Math.min(floor, ceiling);
  const hi = Math.max(floor, ceiling);
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function isColocatedSocketMode(config) {
  return config.kind === "socket";
}
async function connectInstance(options = {}) {
  const initialBackoffMs = normalizeReconnectDelayMs(options.reconnectDelayMs);
  const config = options.config ?? resolveInstanceConfig();
  const env = Deno.env.toObject();
  const caCertPath = resolveInstanceCaPath(env);
  const httpClient = options.httpClient ?? await createInstanceHttpClient(config, {
    caCertPath
  });
  const client = new InstanceClient({
    ...options,
    config,
    httpClient,
    reconnectDelayMs: initialBackoffMs
  });
  const socketMode = isColocatedSocketMode(config);
  if (socketMode) {
    while (true) {
      try {
        const readiness = await client.fetchDaemonReadiness();
        if (readiness.ready) {
          logInfo("instance", "instance ready for daemon registration via", sanitizeForLog2(client.target));
          break;
        }
      } catch {
      }
      await delay4(fullJitterMs(initialBackoffMs, INSTALL_READINESS_POLL_MS));
    }
  } else {
    let waitingLogged = false;
    let readyLogged = false;
    let backoffMs = initialBackoffMs;
    while (true) {
      try {
        await client.fetchHealth();
        if (!readyLogged) {
          logInfo("instance", "instance available via", sanitizeForLog2(client.target));
          readyLogged = true;
        }
        break;
      } catch {
        if (!waitingLogged) {
          logInfo("instance", "waiting for instance to become available via", sanitizeForLog2(client.target));
          waitingLogged = true;
        }
        await delay4(fullJitterMs(initialBackoffMs, backoffMs));
        backoffMs = nextBackoffMs(backoffMs, DEFAULT_MAX_BACKOFF_MS);
      }
    }
  }
  client.start();
  return client;
}
var DEFAULT_INITIAL_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS, BACKOFF_MULTIPLIER, STABLE_SESSION_MS, UPDATE_RESULT_HANDOFF_DELAY_MS, INSTALL_READINESS_POLL_MS, INSTANCE_RESTART_WAIT_MS, SERVER_ID_FILE2, SERVER_KEY_FILE3, KEY_ID_FILE2, InstanceClient;
var init_client2 = __esm({
  "src/instance/client.ts"() {
    init_restart_daemon_service();
    init_command_router();
    init_paths2();
    init_server_addresses();
    init_dev_sync_apply();
    init_public_urls_apply();
    init_tunnels();
    init_logger();
    init_keys();
    init_api_client();
    init_token_manager();
    init_enroll();
    init_base64();
    init_build_info();
    init_idle_presence();
    init_config();
    init_resolver();
    init_run_reconcile();
    DEFAULT_INITIAL_BACKOFF_MS = 2e3;
    DEFAULT_MAX_BACKOFF_MS = 3e4;
    BACKOFF_MULTIPLIER = 2;
    STABLE_SESSION_MS = 5e3;
    UPDATE_RESULT_HANDOFF_DELAY_MS = 2e3;
    INSTALL_READINESS_POLL_MS = 5e3;
    INSTANCE_RESTART_WAIT_MS = 12e4;
    SERVER_ID_FILE2 = "server.id";
    SERVER_KEY_FILE3 = "server-key.json";
    KEY_ID_FILE2 = "server-key-id";
    InstanceClient = class {
      #config;
      #httpClient;
      #initialBackoffMs;
      #maxBackoffMs;
      #onMessage;
      #ws;
      #stopped = false;
      #connectLoopStarted = false;
      #backoffMs;
      #hadStableSession = false;
      #devSync = /* @__PURE__ */ new Map();
      #tokenManager;
      #apiClient;
      #tokenServerId;
      #tokenKeyId;
      #forceEnrollPending = false;
      #idlePresence;
      #updateInstallInProgress = false;
      constructor(options = {}) {
        this.#config = options.config ?? resolveInstanceConfig();
        this.#httpClient = options.httpClient;
        this.#initialBackoffMs = normalizeReconnectDelayMs(options.reconnectDelayMs);
        this.#maxBackoffMs = DEFAULT_MAX_BACKOFF_MS;
        this.#backoffMs = this.#initialBackoffMs;
        this.#onMessage = options.onMessage;
      }
      get config() {
        return this.#config;
      }
      get target() {
        return describeInstance(this.#config);
      }
      #fetchInit(init = {}) {
        return this.#httpClient ? {
          ...init,
          client: this.#httpClient
        } : init;
      }
      async fetchHealth() {
        const response = await fetch(instanceUrl(this.#config, "/api/health"), this.#fetchInit());
        if (!response.ok) {
          throw new Error(`health check failed: HTTP ${response.status}`);
        }
        return await response.json();
      }
      async fetchDaemonReadiness() {
        const response = await fetch(instanceUrl(this.#config, "/api/daemon/v1/readiness"), this.#fetchInit());
        let body;
        try {
          body = await response.json();
        } catch {
          throw new Error(`daemon readiness check failed: HTTP ${response.status}`);
        }
        if (!response.ok) {
          if (body.ready === false) {
            return {
              ok: body.ok ?? true,
              ready: false,
              needsInstall: body.needsInstall
            };
          }
          throw new Error(body.error ?? `daemon readiness check failed: HTTP ${response.status}`);
        }
        return {
          ok: body.ok ?? true,
          ready: body.ready === true
        };
      }
      #isColocatedSocketMode() {
        return isColocatedSocketMode(this.#config);
      }
      async #waitForConnectPreconditions() {
        if (this.#isColocatedSocketMode()) {
          const maxWaitMs = this.#hadStableSession ? INSTANCE_RESTART_WAIT_MS : 0;
          const started = Date.now();
          while (true) {
            try {
              const readiness = await this.fetchDaemonReadiness();
              if (readiness.ready) return;
            } catch {
            }
            if (maxWaitMs === 0 || Date.now() - started >= maxWaitMs) {
              throw new Error("instance install incomplete");
            }
            await delay4(fullJitterMs(this.#initialBackoffMs, INSTALL_READINESS_POLL_MS));
          }
        }
        await this.fetchHealth();
      }
      #resetBackoff() {
        this.#backoffMs = this.#initialBackoffMs;
      }
      #increaseBackoff() {
        this.#backoffMs = nextBackoffMs(this.#backoffMs, this.#maxBackoffMs);
      }
      /** Full-jitter sleep: random delay in [floor, ceiling] inclusive. */
      #nextReconnectDelayMs() {
        return fullJitterMs(this.#initialBackoffMs, this.#backoffMs);
      }
      async fetchVersion() {
        const response = await fetch(instanceUrl(this.#config, "/api/daemon/v1/version"), this.#fetchInit());
        if (!response.ok) {
          throw new Error(`version fetch failed: HTTP ${response.status}`);
        }
        return await response.json();
      }
      async fetchConnections() {
        const response = await fetch(instanceUrl(this.#config, "/api/developer/v1/daemon/connections"), this.#fetchInit());
        if (!response.ok) {
          throw new Error(`connections fetch failed: HTTP ${response.status}`);
        }
        return await response.json();
      }
      start() {
        if (this.#connectLoopStarted) return;
        this.#connectLoopStarted = true;
        this.#stopped = false;
        this.#forceEnrollPending = isTruthyFlag2(Deno.env.get("TURBOPANEL_FORCE_ENROLL"));
        this.#runConnectLoop().catch((err) => {
          logWarn("instance", "connect loop exited unexpectedly:", sanitizeForLog2(err));
        });
      }
      stop() {
        this.#stopped = true;
        this.#idlePresence?.detach();
        this.#idlePresence = void 0;
        this.#tokenManager?.stop();
        this.#ws?.close();
        this.#ws = void 0;
      }
      send(message) {
        if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
          throw new Error("instance websocket is not connected");
        }
        this.#ws.send(JSON.stringify(message));
        this.#idlePresence?.touchActivity();
      }
      async #runConnectLoop() {
        while (!this.#stopped) {
          try {
            await this.#connectOnce();
          } catch (err) {
            const logConnectFailure = this.#hadStableSession ? logWarn : logDebug;
            logConnectFailure("instance", "websocket connect failed:", sanitizeForLog2(err));
            this.#closeActiveSocket();
            this.#idlePresence?.detach();
            this.#increaseBackoff();
          }
          if (this.#stopped) break;
          const reconnectDelayMs = this.#nextReconnectDelayMs();
          logDebug("instance", "reconnect scheduled in", reconnectDelayMs, "ms (ceiling", this.#backoffMs, "ms) via", sanitizeForLog2(this.target));
          await delay4(reconnectDelayMs);
        }
      }
      #newWebSocket(jwt) {
        const url = instanceWebSocketUrl(this.#config, "/ws/daemon/v1");
        const options = this.#httpClient ? {
          headers: {
            Authorization: `Bearer ${jwt}`
          },
          client: this.#httpClient
        } : {
          headers: {
            Authorization: `Bearer ${jwt}`
          }
        };
        try {
          return new WebSocket(url, options);
        } catch (error) {
          throw new Error(`websocket runtime does not support Authorization headers: ${sanitizeForLog2(error)}`);
        }
      }
      #closeActiveSocket() {
        const ws = this.#ws;
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
          return;
        }
        try {
          ws.close();
        } catch {
        }
        if (this.#ws === ws) this.#ws = void 0;
      }
      async #connectOnce() {
        await this.#waitForConnectPreconditions();
        const stateDir = resolveServerIdDir();
        const machineId = await readMachineId();
        const hostname = Deno.hostname();
        let keyFile = null;
        let serverId;
        let keyId;
        for (let attempt = 0; attempt < 2; attempt++) {
          const [loadedKeyFile, loadedServerId, loadedKeyId] = await Promise.all([
            readDaemonKeyFile(),
            readServerId(),
            readKeyId()
          ]);
          keyFile = loadedKeyFile;
          serverId = loadedServerId;
          keyId = loadedKeyId;
          const needsEnrollment = this.#forceEnrollPending || keyFile === null || !serverId || !keyId;
          if (needsEnrollment) {
            const licenseCredentials = await readLicenseCredentials();
            if (!licenseCredentials.licenseId || !licenseCredentials.licenseToken) {
              throw new Error("missing license credentials for enrollment");
            }
            const enrollClient = this.#apiClient ?? new DaemonApiClient({
              config: this.#config,
              httpClient: this.#httpClient,
              getToken: async () => {
                throw new Error("token unavailable before enrollment");
              }
            });
            const enrollment = await enrollDaemon({
              apiClient: enrollClient,
              machineId,
              hostname,
              licenseId: licenseCredentials.licenseId,
              licenseToken: licenseCredentials.licenseToken,
              stateDir
            });
            keyFile = enrollment.keyFile;
            serverId = enrollment.serverId;
            keyId = enrollment.keyId;
            this.#forceEnrollPending = false;
            logInfo("instance", "enrolled with instance as", sanitizeForLog2(serverId));
          }
          if (keyFile === null || !serverId || !keyId) {
            throw new Error("daemon identity incomplete after enrollment/auth bootstrap");
          }
          if (!this.#tokenManager || !this.#apiClient || this.#tokenServerId !== serverId || this.#tokenKeyId !== keyId) {
            let tokenManagerRef;
            const apiClient = new DaemonApiClient({
              config: this.#config,
              httpClient: this.#httpClient,
              getToken: async (options) => {
                if (!tokenManagerRef) {
                  throw new Error("token manager not initialized");
                }
                return await tokenManagerRef.getToken(options);
              }
            });
            const tokenManager = new DaemonTokenManager({
              keyFile,
              serverId,
              keyId,
              machineId,
              hostname,
              apiClient
            });
            tokenManagerRef = tokenManager;
            this.#tokenManager = tokenManager;
            this.#apiClient = apiClient;
            this.#tokenServerId = serverId;
            this.#tokenKeyId = keyId;
          }
          try {
            const jwt = await this.#tokenManager.getToken();
            await this.#openDaemonWebSocket(jwt, serverId);
            return;
          } catch (err) {
            if (attempt === 0 && isStaleDaemonIdentityError(err)) {
              logWarn("instance", "daemon identity is stale for this instance; clearing local state and re-enrolling");
              await clearDaemonIdentityState(stateDir);
              this.#tokenManager = void 0;
              this.#apiClient = void 0;
              this.#tokenServerId = void 0;
              this.#tokenKeyId = void 0;
              this.#forceEnrollPending = true;
              continue;
            }
            throw err;
          }
        }
        throw new Error("daemon identity bootstrap failed after stale identity retry");
      }
      async #openDaemonWebSocket(jwt, serverId) {
        const ws = this.#newWebSocket(jwt);
        this.#ws = ws;
        let sessionRegistered = false;
        this.#ensureIdlePresence(serverId);
        try {
          await new Promise((resolve3, reject) => {
            const fail = (err) => {
              cleanup();
              reject(err instanceof Error ? err : new Error(String(err)));
            };
            const cleanup = () => {
              ws.removeEventListener("open", onOpen);
              ws.removeEventListener("error", onError);
              ws.removeEventListener("close", onClose);
            };
            const onOpen = () => {
              cleanup();
              resolve3();
            };
            const onError = (event) => {
              fail(event.message ?? "websocket error");
            };
            const onClose = () => {
              fail("websocket closed before open");
            };
            ws.addEventListener("open", onOpen);
            ws.addEventListener("error", onError);
            ws.addEventListener("close", onClose);
          });
        } catch (err) {
          await this.#tokenManager?.refresh().catch(() => {
          });
          throw err;
        }
        logDebug("instance", "websocket connected via", sanitizeForLog2(this.target));
        sessionRegistered = true;
        this.#hadStableSession = true;
        const connectedAt = Date.now();
        this.#idlePresence?.attach(ws);
        ws.onmessage = (event) => {
          this.#idlePresence?.touchActivity();
          const raw = typeof event.data === "string" ? event.data : String(event.data);
          const message = parseMessage(raw);
          if (!message) {
            logWarn("instance", "ignored non-JSON websocket message");
            return;
          }
          this.#onMessage?.(message);
          this.#handleMessage(message, ws);
        };
        ws.onclose = (event) => {
          if (event.code === 4401) {
            logWarn("instance", "authentication rejected");
          }
          if (sessionRegistered) {
            logInfo("instance", "websocket closed after registration");
          } else {
            logDebug("instance", "websocket closed before registration");
          }
          if (this.#ws === ws) this.#ws = void 0;
          this.#idlePresence?.detach();
        };
        const closeEvent = await new Promise((resolve3) => {
          ws.addEventListener("close", (event) => resolve3(event), {
            once: true
          });
        });
        const wasAuthFailure = closeEvent.code === 4401;
        if (wasAuthFailure) {
          await this.#tokenManager?.refresh();
        }
        const wasStableSession = sessionRegistered && !wasAuthFailure && Date.now() - connectedAt >= STABLE_SESSION_MS;
        if (wasStableSession) {
          this.#resetBackoff();
        } else {
          this.#increaseBackoff();
        }
      }
      #ensureIdlePresence(serverId) {
        if (this.#idlePresence && this.#tokenServerId === serverId) {
          return;
        }
        this.#idlePresence?.detach();
        this.#idlePresence = new IdlePresence({
          serverId
        });
      }
      #handleMessage(message, ws) {
        switch (message.type) {
          case "version":
            break;
          case "echo":
            logDebug("instance", "echo from instance:", sanitizeForLog2(message.payload));
            ws.send(JSON.stringify({
              type: "echo",
              payload: {
                received: message.payload,
                from: "daemon"
              },
              at: (/* @__PURE__ */ new Date()).toISOString()
            }));
            break;
          case "command-dispatch":
            handleCommandDispatch(message, ws).catch((err) => {
              logWarn("instance", "command-dispatch handler failed:", sanitizeForLog2(err));
            });
            break;
          case "command":
            if (isTruthyFlag2(Deno.env.get("TURBOPANEL_DEV_SHELL_COMMANDS"))) {
              this.#runCommand(message, ws).catch((err) => {
                logWarn("instance", "command handler failed:", sanitizeForLog2(err));
              });
            } else {
              logWarn("instance", "ignoring legacy shell command \u2014 set TURBOPANEL_DEV_SHELL_COMMANDS=1 for dev-only use");
            }
            break;
          case "addresses-request":
            this.#collectAddresses(message, ws);
            break;
          case "dev-sync-begin":
            this.#devSync.set(message.id, newDevSyncState(message.totalChunks));
            break;
          case "dev-sync-chunk": {
            const state = this.#devSync.get(message.id);
            if (state) state.chunks[message.index] = message.data;
            break;
          }
          case "dev-sync-end":
            this.#applyDevSync(message.id, ws).catch((err) => {
              logWarn("instance", "dev-sync handler failed:", sanitizeForLog2(err));
            });
            break;
          case "tunnel-token":
            this.#applyTunnelToken(message, ws).catch((err) => {
              logWarn("instance", "tunnel-token handler failed:", sanitizeForLog2(err));
            });
            break;
          case "public-urls-update":
            this.#applyPublicUrls(message, ws).catch((err) => {
              logWarn("instance", "public-urls-update handler failed:", sanitizeForLog2(err));
            });
            break;
          case "update":
            void this.#applyUpdate(message, ws).catch((err) => {
              logWarn("instance", "update handler failed:", sanitizeForLog2(err));
            });
            break;
        }
      }
      async #applyDevSync(id, ws) {
        const state = this.#devSync.get(id);
        this.#devSync.delete(id);
        let ok = false;
        let error;
        try {
          if (!state) throw new Error("no dev-sync in progress for this id");
          const base64 = state.chunks.join("");
          const bytes = decodeBase64(base64);
          await applyDevSyncTarball(bytes);
          ok = true;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          logError("dev-sync", "failed:", sanitizeForLog2(error));
        }
        const result = {
          type: "dev-sync-result",
          id,
          ok,
          error,
          at: (/* @__PURE__ */ new Date()).toISOString()
        };
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
        if (ok) await restartDaemonService();
      }
      async #applyTunnelToken(message, ws) {
        let ok = false;
        let error;
        try {
          await writeInstanceTunnelToken(message.token);
          ok = true;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          logError("tunnel-token", "failed:", sanitizeForLog2(error));
        }
        const result = {
          type: "tunnel-token-result",
          id: message.id,
          ok,
          error,
          at: (/* @__PURE__ */ new Date()).toISOString()
        };
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
      }
      async #applyPublicUrls(message, ws) {
        let ok = false;
        let error;
        try {
          await applyPublicUrls(message.urls);
          ok = true;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          logError("public-urls", "failed:", sanitizeForLog2(error));
        }
        const result = {
          type: "public-urls-update-result",
          id: message.id,
          ok,
          error,
          at: (/* @__PURE__ */ new Date()).toISOString()
        };
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
      }
      async #applyUpdate(message, ws) {
        if (this.#updateInstallInProgress) {
          const busy = {
            type: "update-result",
            id: message.id,
            ok: false,
            error: "update already in progress",
            at: (/* @__PURE__ */ new Date()).toISOString()
          };
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(busy));
          return;
        }
        this.#updateInstallInProgress = true;
        let ok = false;
        let shouldRestart = false;
        let error;
        try {
          let config = resolveUpdateChannelConfig(Deno.env.toObject());
          const msgChannel = message.channel?.trim();
          if (msgChannel) {
            try {
              config = resolveUpdateChannelConfig({
                ...Deno.env.toObject(),
                TURBOPANEL_UPDATE_CHANNEL: msgChannel
              });
            } catch {
            }
          }
          const updateInfo = await resolveUpdate(config);
          if (getBuildInfo().commit === updateInfo.commit) {
            logInfo("update", "already on current commit", sanitizeForLog2(updateInfo.commit));
            ok = true;
          } else {
            const credentials = await readLicenseCredentials();
            if (!credentials.licenseId || !credentials.licenseToken) {
              throw new Error("license credentials missing; re-run the installer with --license");
            }
            const env = Deno.env.toObject();
            const instanceUrl2 = env.TURBOPANEL_INSTANCE_URL?.trim();
            const instanceCaPath = resolveInstanceCaPath(env);
            const runScriptUrl = resolveRunScriptUrl(this.#config);
            const insecureTls = resolveBootstrapInsecureTls({
              releaseTlsInsecure: env.TURBOPANEL_RELEASE_TLS_INSECURE,
              runScriptUrl,
              instanceCaPath
            });
            const licenseArg = encodeLicenseArg(credentials.licenseId, credentials.licenseToken);
            const reconcileArgs = buildRunReconcileArgs({
              licenseArg,
              instanceUrl: instanceUrl2,
              instanceCaPath,
              insecureTls
            });
            logInfo("update", "reconciling via run.sh", sanitizeForLog2(runScriptUrl));
            const script = await downloadRunScript(runScriptUrl, {
              insecureTls,
              caPath: insecureTls ? void 0 : instanceCaPath
            });
            await executeRunReconcile({
              script,
              args: reconcileArgs,
              channel: config.channel
            });
            ok = true;
            shouldRestart = true;
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          logError("update", "failed:", sanitizeForLog2(error));
        }
        const result = {
          type: "update-result",
          id: message.id,
          ok,
          error,
          at: (/* @__PURE__ */ new Date()).toISOString()
        };
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(result));
        if (ok && shouldRestart) {
          await new Promise((resolve3) => setTimeout(resolve3, UPDATE_RESULT_HANDOFF_DELAY_MS));
          const restarted = await restartDaemonService();
          if (!restarted) {
            logWarn("update", "reconcile succeeded but systemd restart failed; daemon may still be on old code");
          }
        }
        this.#updateInstallInProgress = false;
      }
      #collectAddresses(message, ws) {
        let addresses;
        try {
          addresses = collectServerAddresses();
        } catch (err) {
          logWarn("instance", "collect addresses failed:", sanitizeForLog2(err));
          addresses = {
            privateIpv4: [],
            privateIpv6: [],
            publicIpv4: [],
            publicIpv6: []
          };
        }
        const result = {
          type: "addresses-result",
          id: message.id,
          addresses,
          at: (/* @__PURE__ */ new Date()).toISOString()
        };
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(result));
        }
      }
      /**
       * Run a shell command requested by the instance and stream the result back.
       *
       * Dev-only. Gate with `TURBOPANEL_DEV_SHELL_COMMANDS=1`. Never set in
       * production. Production commands use typed handlers in `src/instance/commands/`.
       */
      async #runCommand(message, ws) {
        logInfo("instance", "run command:", stripLogInjection4(message.command));
        let result;
        try {
          const command = new Deno.Command("sh", {
            args: [
              "-c",
              message.command
            ],
            stdout: "piped",
            stderr: "piped"
          });
          const { code, stdout, stderr } = await command.output();
          result = {
            type: "command-result",
            id: message.id,
            exitCode: code,
            stdout: new TextDecoder().decode(stdout),
            stderr: new TextDecoder().decode(stderr),
            at: (/* @__PURE__ */ new Date()).toISOString()
          };
        } catch (err) {
          result = {
            type: "command-result",
            id: message.id,
            exitCode: -1,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            at: (/* @__PURE__ */ new Date()).toISOString()
          };
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(result));
        }
      }
    };
  }
});

// src/monitor/protocol.ts
var MONITOR_PROTOCOL_VERSION, MONITOR_RESOURCE_STATUSES, MONITOR_RESOURCE_STATUS_SET;
var init_protocol = __esm({
  "src/monitor/protocol.ts"() {
    MONITOR_PROTOCOL_VERSION = 1;
    MONITOR_RESOURCE_STATUSES = [
      "unknown",
      "starting",
      "healthy",
      "degraded",
      "unhealthy",
      "stopped",
      "failed",
      "offline"
    ];
    MONITOR_RESOURCE_STATUS_SET = new Set(MONITOR_RESOURCE_STATUSES);
  }
});

// src/monitor/delta.ts
function resourceSnapshotForDiff(resource) {
  const { updatedAt: _updatedAt, ...snapshot } = resource;
  return snapshot;
}
function resourceMeaningfulFieldsChanged(previous, next) {
  return JSON.stringify(resourceSnapshotForDiff(previous)) !== JSON.stringify(resourceSnapshotForDiff(next));
}
function snapshotResources(resources) {
  const map = /* @__PURE__ */ new Map();
  for (const resource of resources) {
    map.set(resource.resourceKey, resource);
  }
  return map;
}
function diffResources(prev, next, sequence, at) {
  const changed = [];
  const events = [];
  for (const resource of next) {
    const previous = prev.get(resource.resourceKey);
    if (!previous) {
      changed.push(resource);
      events.push({
        resourceKey: resource.resourceKey,
        kind: resource.kind,
        toStatus: resource.status,
        at,
        reason: "discovered",
        sequence
      });
      continue;
    }
    const statusChanged = previous.status !== resource.status;
    const snapshotChanged = resourceMeaningfulFieldsChanged(previous, resource);
    if (statusChanged) {
      events.push({
        resourceKey: resource.resourceKey,
        kind: resource.kind,
        fromStatus: previous.status,
        toStatus: resource.status,
        at,
        reason: "status_change",
        sequence
      });
    }
    if (statusChanged || snapshotChanged) {
      changed.push(resource);
    }
  }
  for (const [resourceKey, previous] of prev) {
    if (!next.some((resource) => resource.resourceKey === resourceKey)) {
      const offlineResource = {
        ...previous,
        status: "offline",
        updatedAt: at
      };
      changed.push(offlineResource);
      events.push({
        resourceKey,
        kind: previous.kind,
        fromStatus: previous.status,
        toStatus: "offline",
        at,
        reason: "removed",
        sequence
      });
    }
  }
  return {
    changed,
    events
  };
}
function createMonitorDeltaTracker() {
  let sequence = 0;
  let deliveredSequence = 0;
  const deliveredBaseline = /* @__PURE__ */ new Map();
  const pendingDeliveries = /* @__PURE__ */ new Map();
  function replaceDeliveredBaseline(resources) {
    deliveredBaseline.clear();
    for (const resource of resources) {
      deliveredBaseline.set(resource.resourceKey, resource);
    }
  }
  function seedTracked(resources) {
    replaceDeliveredBaseline(resources);
    deliveredSequence = 0;
    sequence = 0;
    pendingDeliveries.clear();
  }
  function applyAck(acceptedSequence) {
    if (acceptedSequence <= deliveredSequence) return;
    let confirmedSequence = -1;
    let snapshot;
    for (const [pendingSequence, pendingSnapshot] of pendingDeliveries) {
      if (pendingSequence <= acceptedSequence && pendingSequence > confirmedSequence) {
        confirmedSequence = pendingSequence;
        snapshot = pendingSnapshot;
      }
    }
    if (confirmedSequence <= deliveredSequence) return;
    if (snapshot) {
      deliveredBaseline.clear();
      for (const [resourceKey, resource] of snapshot) {
        deliveredBaseline.set(resourceKey, resource);
      }
    }
    deliveredSequence = confirmedSequence;
    for (const pendingSequence of pendingDeliveries.keys()) {
      if (pendingSequence <= confirmedSequence) {
        pendingDeliveries.delete(pendingSequence);
      }
    }
  }
  function registerPendingDelivery(deliverySequence, resourcesAfter) {
    pendingDeliveries.set(deliverySequence, snapshotResources(resourcesAfter));
    if (deliverySequence > sequence) {
      sequence = deliverySequence;
    }
  }
  function confirmDelivery(deliverySequence, resourcesAfter) {
    registerPendingDelivery(deliverySequence, resourcesAfter);
    applyAck(deliverySequence);
  }
  function buildSync(instance2, resources) {
    const nextSequence = sequence + 1;
    const at = (/* @__PURE__ */ new Date()).toISOString();
    return {
      sequence: nextSequence,
      resourcesAfter: resources,
      payload: {
        type: "monitor.sync",
        at,
        sequence: nextSequence,
        instance: instance2,
        resources,
        protocolVersion: MONITOR_PROTOCOL_VERSION
      }
    };
  }
  function previewTransitionEvents(resourceKey, next, at, nextSequence) {
    const previous = deliveredBaseline.get(resourceKey);
    if (!previous) {
      return [
        {
          resourceKey: next.resourceKey,
          kind: next.kind,
          toStatus: next.status,
          at,
          reason: "discovered",
          sequence: nextSequence
        }
      ];
    }
    if (previous.status === next.status) return [];
    return [
      {
        resourceKey: next.resourceKey,
        kind: next.kind,
        fromStatus: previous.status,
        toStatus: next.status,
        at,
        reason: "status_change",
        sequence: nextSequence
      }
    ];
  }
  function buildHeartbeat(instance2, resources) {
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const nextSequence = sequence + 1;
    const { changed, events } = diffResources(deliveredBaseline, resources, nextSequence, at);
    const payload = {
      type: "monitor.heartbeat",
      at,
      sequence: nextSequence,
      instance: instance2
    };
    if (changed.length > 0) payload.resources = changed;
    if (events.length > 0) payload.events = events;
    return {
      sequence: nextSequence,
      resourcesAfter: resources,
      payload
    };
  }
  function buildTransition(resourceKey, next, resourcesAfter) {
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const nextSequence = sequence + 1;
    const events = previewTransitionEvents(resourceKey, next, at, nextSequence);
    if (events.length === 0) return null;
    return {
      sequence: nextSequence,
      resourcesAfter,
      payload: {
        type: "monitor.transition",
        at,
        sequence: nextSequence,
        events,
        resources: [
          next
        ]
      }
    };
  }
  function buildRemovalTransition(resourceKey, previous, resourcesAfter) {
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const nextSequence = sequence + 1;
    const offlineResource = {
      ...previous,
      status: "offline",
      updatedAt: at
    };
    return {
      sequence: nextSequence,
      resourcesAfter,
      payload: {
        type: "monitor.transition",
        at,
        sequence: nextSequence,
        events: [
          {
            resourceKey,
            kind: previous.kind,
            fromStatus: previous.status,
            toStatus: "offline",
            at,
            reason: "removed",
            sequence: nextSequence
          }
        ],
        resources: [
          offlineResource
        ]
      }
    };
  }
  return {
    buildSync,
    buildHeartbeat,
    buildTransition,
    buildRemovalTransition,
    seedTracked,
    applyAck,
    registerPendingDelivery,
    confirmDelivery,
    getSequence: () => sequence,
    getDeliveredSequence: () => deliveredSequence,
    getDeliveredBaseline: () => new Map(deliveredBaseline)
  };
}
var init_delta = __esm({
  "src/monitor/delta.ts"() {
    init_protocol();
  }
});

// src/monitor/host-summary.ts
function readProcFile(path) {
  try {
    return Deno.readTextFileSync(path);
  } catch {
  }
  try {
    const { code, stdout } = new Deno.Command("cat", {
      args: [
        path
      ],
      stdout: "piped",
      stderr: "null"
    }).outputSync();
    if (code !== 0) return void 0;
    return new TextDecoder().decode(stdout);
  } catch {
    return void 0;
  }
}
function parseCpuLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5 || parts[0] !== "cpu") return void 0;
  const values = parts.slice(1).map(Number);
  if (values.some((n) => Number.isNaN(n))) return void 0;
  const user = values[0] ?? 0;
  const nice = values[1] ?? 0;
  const system = values[2] ?? 0;
  const idle = values[3] ?? 0;
  const iowait = values[4] ?? 0;
  const irq = values[5] ?? 0;
  const softirq = values[6] ?? 0;
  const steal = values[7] ?? 0;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return {
    total,
    idle
  };
}
function countCpuCores(statText) {
  let cores = 0;
  for (const line of statText.split("\n")) {
    if (/^cpu\d+\s/.test(line.trim())) cores++;
  }
  return cores;
}
function parseMeminfo(text) {
  let memTotal;
  let memAvailable;
  for (const line of text.split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)\s+kB/);
    if (!match) continue;
    if (match[1] === "MemTotal") memTotal = Number(match[2]) * 1024;
    if (match[1] === "MemAvailable") memAvailable = Number(match[2]) * 1024;
  }
  if (memTotal === void 0 || memAvailable === void 0) return void 0;
  const usedBytes = memTotal - memAvailable;
  const usagePercent = memTotal > 0 ? Math.round(usedBytes / memTotal * 1e3) / 10 : void 0;
  return {
    usedBytes,
    totalBytes: memTotal,
    usagePercent
  };
}
function parseLoadavg(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) return void 0;
  const one = Number(parts[0]);
  const five = Number(parts[1]);
  const fifteen = Number(parts[2]);
  if ([
    one,
    five,
    fifteen
  ].some((n) => Number.isNaN(n))) return void 0;
  return {
    one,
    five,
    fifteen
  };
}
function parseUptime(text) {
  const first = text.trim().split(/\s+/)[0];
  if (!first) return void 0;
  const seconds = Number(first);
  return Number.isFinite(seconds) ? Math.floor(seconds) : void 0;
}
async function collectDiskSummary() {
  try {
    const command = new Deno.Command("df", {
      args: [
        "-kP",
        "/"
      ],
      stdout: "piped",
      stderr: "null"
    });
    const { code, stdout } = await command.output();
    if (code !== 0) return void 0;
    const text = new TextDecoder().decode(stdout);
    const lines = text.trim().split("\n");
    if (lines.length < 2) return void 0;
    const parts = lines[1].trim().split(/\s+/);
    if (parts.length < 4) return void 0;
    const totalBytes = Number(parts[1]) * 1024;
    const usedBytes = Number(parts[2]) * 1024;
    if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes)) {
      return void 0;
    }
    const usagePercent = totalBytes > 0 ? Math.round(usedBytes / totalBytes * 1e3) / 10 : void 0;
    return {
      usedBytes,
      totalBytes,
      usagePercent
    };
  } catch {
    return void 0;
  }
}
function createHostSummaryCollector() {
  let previousCpu;
  return {
    async collect() {
      const summary = {};
      const statText = readProcFile("/proc/stat");
      if (statText) {
        const firstLine = statText.split("\n")[0];
        if (firstLine) {
          const current = parseCpuLine(firstLine);
          if (current) {
            const cores = countCpuCores(statText);
            summary.cpu = {
              cores
            };
            if (previousCpu) {
              const totalDelta = current.total - previousCpu.total;
              const idleDelta = current.idle - previousCpu.idle;
              if (totalDelta > 0) {
                const usage = (totalDelta - idleDelta) / totalDelta * 100;
                summary.cpu.usagePercent = Math.round(usage * 10) / 10;
              }
            }
            previousCpu = current;
          }
        }
      }
      const memText = readProcFile("/proc/meminfo");
      if (memText) {
        summary.memory = parseMeminfo(memText);
      }
      const loadText = readProcFile("/proc/loadavg");
      if (loadText) {
        summary.load = parseLoadavg(loadText);
      }
      const uptimeText = readProcFile("/proc/uptime");
      if (uptimeText) {
        summary.uptimeSeconds = parseUptime(uptimeText);
      }
      const bootId = readProcFile("/proc/sys/kernel/random/boot_id");
      if (bootId) {
        summary.bootId = bootId.trim();
      }
      summary.disk = await collectDiskSummary();
      return summary;
    }
  };
}
var init_host_summary = __esm({
  "src/monitor/host-summary.ts"() {
  }
});

// src/monitor/normalize.ts
function shortContainerId(id) {
  return id.replace(/^\/+/, "").slice(0, 12);
}
function stripLeadingSlash(name) {
  return name.startsWith("/") ? name.slice(1) : name;
}
function resolveContainerName(input) {
  if (input.inspect?.Name) {
    return stripLeadingSlash(input.inspect.Name);
  }
  const names = input.summary?.Names;
  if (names && names.length > 0) {
    return stripLeadingSlash(names[0]);
  }
  return void 0;
}
function resolveLabels(input) {
  const fromInspect = input.inspect?.Config?.Labels;
  if (fromInspect && Object.keys(fromInspect).length > 0) return fromInspect;
  const fromSummary = input.summary?.Labels;
  if (fromSummary && Object.keys(fromSummary).length > 0) return fromSummary;
  return void 0;
}
function mapHealthStatus(status) {
  switch (status.toLowerCase()) {
    case "healthy":
      return "healthy";
    case "unhealthy":
      return "unhealthy";
    case "starting":
      return "starting";
    default:
      return void 0;
  }
}
function mapDockerStateStatus(status, exitCode) {
  switch (status.toLowerCase()) {
    case "running":
      return "healthy";
    case "restarting":
    case "created":
      return "starting";
    case "paused":
      return "degraded";
    case "exited":
      return exitCode === 0 ? "stopped" : "failed";
    case "dead":
      return "failed";
    default:
      return "unknown";
  }
}
function deriveStatusFromEventAction(action) {
  const healthMatch = action.match(/^health_status:\s*(.+)$/i);
  if (healthMatch) {
    return mapHealthStatus(healthMatch[1].trim());
  }
  return void 0;
}
function deriveContainerStatus(input) {
  if (input.event?.Action) {
    const fromEvent = deriveStatusFromEventAction(input.event.Action);
    if (fromEvent) return fromEvent;
  }
  const healthStatus = input.inspect?.State?.Health?.Status;
  if (healthStatus) {
    const mapped = mapHealthStatus(healthStatus);
    if (mapped) return mapped;
  }
  const dockerStatus = input.inspect?.State?.Status ?? input.summary?.State;
  if (dockerStatus) {
    return mapDockerStateStatus(dockerStatus, input.inspect?.State?.ExitCode);
  }
  return "unknown";
}
function formatPorts(input) {
  const networkPorts = input.inspect?.NetworkSettings?.Ports;
  if (networkPorts) {
    const formatted = [];
    for (const [privatePort, bindings] of Object.entries(networkPorts)) {
      if (!bindings || bindings.length === 0) continue;
      for (const binding of bindings) {
        const host = binding.HostIp && binding.HostIp !== "0.0.0.0" ? binding.HostIp : "0.0.0.0";
        const hostPort = binding.HostPort ?? "?";
        formatted.push(`${host}:${hostPort}->${privatePort}`);
      }
    }
    if (formatted.length > 0) return formatted;
  }
  const summaryPorts = input.summary?.Ports;
  if (summaryPorts && summaryPorts.length > 0) {
    return summaryPorts.map((port) => {
      const host = port.IP && port.IP !== "0.0.0.0" ? port.IP : "0.0.0.0";
      const publicPort = port.PublicPort ?? "?";
      return `${host}:${publicPort}->${port.PrivatePort}/${port.Type}`;
    });
  }
  return void 0;
}
function resolveImage(input) {
  return input.inspect?.Config?.Image ?? input.inspect?.Image ?? input.summary?.Image;
}
function isMeaningfulDockerTimestamp(value) {
  return value !== void 0 && value !== "" && value !== DOCKER_ZERO_TIME;
}
function resolveUpdatedAt(input) {
  if (input.event?.time !== void 0) {
    return new Date(input.event.time * 1e3).toISOString();
  }
  const state = input.inspect?.State;
  if (isMeaningfulDockerTimestamp(state?.FinishedAt)) {
    return state.FinishedAt;
  }
  if (isMeaningfulDockerTimestamp(state?.StartedAt)) {
    return state.StartedAt;
  }
  return void 0;
}
function normalizeContainer(input) {
  const fullId = (input.inspect?.Id ?? input.summary?.Id ?? input.event?.Actor?.ID ?? "").replace(/^\/+/, "");
  const labels = resolveLabels(input);
  const status = deriveContainerStatus(input);
  const healthStatus = input.inspect?.State?.Health?.Status;
  const state = {
    resourceKey: `container:${shortContainerId(fullId)}`,
    kind: "container",
    status,
    containerId: fullId
  };
  const updatedAt = resolveUpdatedAt(input);
  if (updatedAt) state.updatedAt = updatedAt;
  const name = resolveContainerName(input);
  if (name) state.name = name;
  const image = resolveImage(input);
  if (image) state.image = image;
  if (healthStatus) state.healthStatus = healthStatus;
  const restartCount = input.inspect?.RestartCount;
  if (restartCount !== void 0) state.restartCount = restartCount;
  const ports = formatPorts(input);
  if (ports) state.ports = ports;
  if (labels) {
    state.labels = labels;
    const projectId = labels[TURBOPANEL_LABEL_KEYS.project];
    const serviceId = labels[TURBOPANEL_LABEL_KEYS.service];
    if (projectId) state.projectId = projectId;
    if (serviceId) state.serviceId = serviceId;
  }
  return state;
}
var TURBOPANEL_LABEL_KEYS, DOCKER_ZERO_TIME;
var init_normalize5 = __esm({
  "src/monitor/normalize.ts"() {
    TURBOPANEL_LABEL_KEYS = {
      project: "com.turbopanel.project",
      service: "com.turbopanel.service"
    };
    DOCKER_ZERO_TIME = "0001-01-01T00:00:00Z";
  }
});

// src/monitor/sentinel.ts
function createEmptyContainerMonitor() {
  return {
    start() {
    },
    waitUntilReady: async () => {
    },
    getContainers: () => [],
    getContainerInspect: () => void 0,
    subscribe: () => () => {
    }
  };
}
function createSentinel(options = {}) {
  return new Sentinel(options);
}
var Sentinel;
var init_sentinel = __esm({
  "src/monitor/sentinel.ts"() {
    init_logger();
    init_delta();
    init_host_summary();
    init_normalize5();
    Sentinel = class {
      #dockerMonitor;
      #dockerEnabled;
      #hostSummaryCollector;
      #delta = createMonitorDeltaTracker();
      #transitionCallbacks = /* @__PURE__ */ new Set();
      #signal;
      #unsubscribe;
      #ready;
      #markReady;
      constructor(options) {
        let markReady;
        this.#ready = new Promise((resolve3) => {
          markReady = resolve3;
        });
        this.#markReady = markReady;
        this.#dockerEnabled = options.dockerMonitor !== void 0;
        this.#dockerMonitor = options.dockerMonitor ?? createEmptyContainerMonitor();
        this.#hostSummaryCollector = options.hostSummaryCollector ?? createHostSummaryCollector();
      }
      onTransition(callback) {
        this.#transitionCallbacks.add(callback);
        return () => {
          this.#transitionCallbacks.delete(callback);
        };
      }
      start(signal) {
        this.#signal = signal;
        logInfo("sentinel", "starting");
        if (this.#dockerEnabled) {
          this.#dockerMonitor.start(signal);
        }
        void this.#bootstrap(signal);
      }
      stop() {
        this.#unsubscribe?.();
        this.#unsubscribe = void 0;
        logInfo("sentinel", "stopped");
      }
      async buildSync() {
        const instance2 = await this.#hostSummaryCollector.collect();
        const resources = this.#collectNormalizedResources();
        return this.#delta.buildSync(instance2, resources);
      }
      async buildHeartbeat() {
        const instance2 = await this.#hostSummaryCollector.collect();
        const resources = this.#collectNormalizedResources();
        return this.#delta.buildHeartbeat(instance2, resources);
      }
      handleAck(acceptedSequence) {
        this.#delta.applyAck(acceptedSequence);
      }
      registerPendingDelivery(sequence, resourcesAfter) {
        this.#delta.registerPendingDelivery(sequence, resourcesAfter);
      }
      confirmDelivery(sequence, resourcesAfter) {
        this.#delta.confirmDelivery(sequence, resourcesAfter);
      }
      async waitForReady() {
        await this.#ready;
      }
      async resetForReconnect() {
        await this.#ready;
        this.#delta.seedTracked(this.#collectNormalizedResources());
      }
      #collectNormalizedResources() {
        if (!this.#dockerEnabled) return [];
        const resources = [];
        for (const summary of this.#dockerMonitor.getContainers()) {
          const inspect = this.#dockerMonitor.getContainerInspect(summary.Id);
          resources.push(normalizeContainer({
            summary,
            inspect
          }));
        }
        return resources;
      }
      async #bootstrap(signal) {
        try {
          if (!this.#dockerEnabled) {
            this.#delta.seedTracked([]);
            return;
          }
          await this.#dockerMonitor.waitUntilReady();
          if (signal.aborted) return;
          this.#delta.seedTracked(this.#collectNormalizedResources());
          this.#unsubscribe = this.#dockerMonitor.subscribe((change) => {
            this.#handleChange(change);
          });
        } catch (err) {
          logWarn("sentinel", "bootstrap failed:", err instanceof Error ? err.message : err);
        } finally {
          this.#markReady();
        }
      }
      #handleChange(change) {
        if (this.#signal?.aborted || !this.#dockerEnabled) return;
        try {
          const resourcesAfter = this.#collectNormalizedResources();
          if (change.removed) {
            const resourceKey = this.#resourceKeyForChange(change);
            let previous = this.#delta.getDeliveredBaseline().get(resourceKey);
            if (!previous && (change.summary || change.inspect)) {
              previous = normalizeContainer({
                summary: change.summary,
                inspect: change.inspect,
                event: change.event
              });
            }
            if (!previous) return;
            const bundle2 = this.#delta.buildRemovalTransition(previous.resourceKey, previous, resourcesAfter);
            this.#emitTransition(bundle2);
            return;
          }
          const normalized = normalizeContainer({
            summary: change.summary,
            inspect: change.inspect,
            event: change.event
          });
          const bundle = this.#delta.buildTransition(normalized.resourceKey, normalized, resourcesAfter);
          if (!bundle) return;
          this.#emitTransition(bundle);
        } catch (err) {
          logWarn("sentinel", "change handling failed:", err instanceof Error ? err.message : err);
        }
      }
      #resourceKeyForChange(change) {
        const fullId = (change.inspect?.Id ?? change.summary?.Id ?? change.containerId).replace(/^\/+/, "");
        return `container:${fullId.slice(0, 12)}`;
      }
      #emitTransition(bundle) {
        for (const callback of this.#transitionCallbacks) {
          try {
            callback(bundle);
          } catch (err) {
            logWarn("sentinel", "transition callback failed:", err instanceof Error ? err.message : err);
          }
        }
      }
    };
  }
});

// src/monitor/index.ts
var init_monitor2 = __esm({
  "src/monitor/index.ts"() {
    init_protocol();
    init_delta();
    init_host_summary();
    init_normalize5();
    init_sentinel();
  }
});

// src/daemon-run.ts
var daemon_run_exports = {};
var orchestrationReady, abort, shuttingDown, dockerClient, sentinelOptions, sentinel, instanceHandle, instance;
var init_daemon_run = __esm({
  async "src/daemon-run.ts"() {
    init_docker();
    init_client2();
    init_logger();
    init_monitor2();
    init_setup();
    init_tunnels();
    logInfo("daemon", "starting up");
    orchestrationReady = await initOrchestration();
    abort = new AbortController();
    shuttingDown = false;
    sentinelOptions = {};
    if (orchestrationReady && shouldEnableDockerIntegration()) {
      dockerClient = new DockerClient();
      if (!await dockerClient.ping()) {
        logWarn("docker", "Docker socket not reachable yet \u2014 monitor will retry on each poll");
      }
      sentinelOptions.dockerMonitor = new DockerMonitor(dockerClient);
    }
    sentinel = createSentinel(sentinelOptions);
    sentinel.start(abort.signal);
    await startTunnels(abort.signal);
    instanceHandle = {
      stop() {
      }
    };
    instance = instanceHandle;
    if (shouldConnectToInstance()) {
      instance = await connectInstance();
    } else {
      logInfo("instance", "connection deferred until development environment opt-in (TURBOPANEL_DEV_INSTANCE)");
    }
    for (const signal of [
      "SIGINT",
      "SIGTERM"
    ]) {
      Deno.addSignalListener(signal, () => {
        if (shuttingDown) return;
        shuttingDown = true;
        logInfo("daemon", "shutting down");
        instance.stop();
        sentinel.stop();
        try {
          dockerClient?.close();
        } catch {
        }
        dockerClient = void 0;
        abort.abort();
      });
    }
    await new Promise((resolve3) => {
      abort.signal.addEventListener("abort", () => resolve3());
    });
    logInfo("daemon", "shut down");
    Deno.exit(0);
  }
});

// main.ts
init_build_info();

// src/orchestration/bootstrap-once.ts
init_ansible();
init_bundle_extract();
init_python();
init_uv();
async function runBootstrapOrchestration() {
  await ensureOrchestrationTree();
  await ensureUv();
  await ensurePython();
  await bootstrapOrchestrationRuntime();
}

// main.ts
init_setup();
if (Deno.args[0] === "bootstrap-orchestration") {
  try {
    await runBootstrapOrchestration();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[bootstrap] ${message}`);
    Deno.exit(1);
  }
  Deno.exit(0);
}
if (Deno.args[0] === "run-installer") {
  let instanceUrl2;
  let start = true;
  let instanceCa;
  let tunnelToken;
  for (let i = 1; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    switch (arg) {
      case "--instance-url": {
        const value = Deno.args[++i];
        if (!value) {
          console.error("[installer] --instance-url requires a value");
          Deno.exit(1);
        }
        instanceUrl2 = value;
        break;
      }
      case "--start": {
        const value = Deno.args[++i];
        if (value !== "true" && value !== "false") {
          console.error("[installer] --start requires true or false");
          Deno.exit(1);
        }
        start = value === "true";
        break;
      }
      case "--instance-ca": {
        const value = Deno.args[++i];
        if (!value) {
          console.error("[installer] --instance-ca requires a value");
          Deno.exit(1);
        }
        instanceCa = value;
        break;
      }
      case "--tunnel-token": {
        const value = Deno.args[++i];
        if (!value) {
          console.error("[installer] --tunnel-token requires a value");
          Deno.exit(1);
        }
        tunnelToken = value;
        break;
      }
      default:
        console.error(`[installer] unknown flag: ${arg}`);
        Deno.exit(1);
    }
  }
  if (!instanceUrl2) {
    console.error("[installer] --instance-url is required");
    Deno.exit(1);
  }
  try {
    await runInstaller({
      instanceUrl: instanceUrl2,
      start,
      instanceCa,
      tunnelToken
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[installer] ${message}`);
    Deno.exit(1);
  }
  Deno.exit(0);
}
await init_daemon_run().then(() => daemon_run_exports);
