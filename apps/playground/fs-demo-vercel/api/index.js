// ../../../packages/kuralle-fs/dist/encoding.js
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder();
function toBuffer(content, encoding) {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (encoding === "base64") {
    return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  }
  if (encoding === "hex") {
    const bytes = new Uint8Array(content.length / 2);
    for (let i = 0; i < content.length; i += 2) {
      bytes[i / 2] = parseInt(content.slice(i, i + 2), 16);
    }
    return bytes;
  }
  if (encoding === "binary" || encoding === "latin1") {
    const chunkSize = 65536;
    if (content.length <= chunkSize) {
      return Uint8Array.from(content, (c) => c.charCodeAt(0));
    }
    const result = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) {
      result[i] = content.charCodeAt(i);
    }
    return result;
  }
  return textEncoder.encode(content);
}
function fromBuffer(buffer, encoding) {
  if (encoding === "base64") {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(buffer).toString("base64");
    }
    const chunkSize = 65536;
    let binary = "";
    for (let i = 0; i < buffer.length; i += chunkSize) {
      const chunk = buffer.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }
  if (encoding === "hex") {
    return Array.from(buffer).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (encoding === "binary" || encoding === "latin1") {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(buffer).toString(encoding);
    }
    const chunkSize = 65536;
    if (buffer.length <= chunkSize) {
      return String.fromCharCode(...buffer);
    }
    let result = "";
    for (let i = 0; i < buffer.length; i += chunkSize) {
      const chunk = buffer.subarray(i, i + chunkSize);
      result += String.fromCharCode(...chunk);
    }
    return result;
  }
  return textDecoder.decode(buffer);
}
function getEncoding(options) {
  if (options === null || options === void 0) {
    return void 0;
  }
  if (typeof options === "string") {
    return options;
  }
  return options.encoding ?? void 0;
}

// ../../../packages/kuralle-fs/dist/path-utils.js
var MAX_SYMLINK_DEPTH = 40;
var DEFAULT_DIR_MODE = 493;
var DEFAULT_FILE_MODE = 420;
var SYMLINK_MODE = 511;
function normalizePath(path) {
  if (!path || path === "/")
    return "/";
  let normalized = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  const resolved = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return `/${resolved.join("/")}`;
}
function validatePath(path, operation) {
  if (path.includes("\0")) {
    throw new Error(`ENOENT: path contains null byte, ${operation} '${path}'`);
  }
}
function dirname(path) {
  const normalized = normalizePath(path);
  if (normalized === "/")
    return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
}
function resolvePath(base, path) {
  if (path.startsWith("/")) {
    return normalizePath(path);
  }
  const combined = base === "/" ? `/${path}` : `${base}/${path}`;
  return normalizePath(combined);
}
function createGlobMatcher(pattern) {
  let i = 0;
  let re = "^";
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          re += "(?:.+/)?";
          i++;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i++;
      } else {
        re += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i + 1);
      if (close === -1) {
        re += "\\{";
        i++;
      } else {
        const inner = pattern.slice(i + 1, close).split(",").join("|");
        re += `(?:${inner})`;
        i = close + 1;
      }
    } else {
      re += ch.replace(/[.+^$|\\()]/g, "\\$&");
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}
function sortPaths(paths) {
  return [...paths].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

// ../../../packages/kuralle-fs/dist/in-memory-fs.js
var utf8 = new TextEncoder();
function split(normalized) {
  return normalized === "/" ? [] : normalized.slice(1).split("/");
}
function freshDir() {
  return {
    kind: "dir",
    children: /* @__PURE__ */ new Map(),
    mode: DEFAULT_DIR_MODE,
    mtime: /* @__PURE__ */ new Date()
  };
}
function kindToType(entry) {
  if (entry.kind === "file" || entry.kind === "lazy")
    return "file";
  if (entry.kind === "dir")
    return "directory";
  return "symlink";
}
function nodeSize(entry) {
  if (entry.kind === "file")
    return entry.bytes.length;
  if (entry.kind === "symlink")
    return entry.target.length;
  return 0;
}
function isInitObj(v) {
  return typeof v === "object" && v !== null && !(v instanceof Uint8Array) && "content" in v;
}
var InMemoryFs = class {
  tree;
  constructor(initialFiles) {
    this.tree = freshDir();
    if (!initialFiles)
      return;
    for (const [p, v] of Object.entries(initialFiles)) {
      if (typeof v === "function") {
        this.insertLazy(p, v);
      } else if (isInitObj(v)) {
        this.insertContent(p, v.content, getEncoding(void 0), v.mode, v.mtime);
      } else {
        this.insertContent(p, v);
      }
    }
  }
  writeFileSync(path, content, options, metadata) {
    this.insertContent(path, content, getEncoding(options), metadata?.mode, metadata?.mtime);
  }
  writeFileLazy(path, lazy, metadata) {
    this.insertLazy(path, lazy, metadata?.mode, metadata?.mtime);
  }
  mkdirSync(path, options) {
    validatePath(path, "mkdir");
    const norm = normalizePath(path);
    if (norm === "/") {
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return;
    }
    const segs = split(norm);
    let dir = this.tree;
    for (let i = 0; i < segs.length; i++) {
      const last = i === segs.length - 1;
      const child = dir.children.get(segs[i]);
      if (child) {
        if (child.kind === "dir") {
          if (last) {
            if (!options?.recursive) {
              throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
            }
            return;
          }
          dir = child;
        } else if (last) {
          throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
        } else if (options?.recursive) {
          const d = freshDir();
          dir.children.set(segs[i], d);
          dir = d;
        } else {
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }
      } else if (last) {
        dir.children.set(segs[i], freshDir());
      } else if (options?.recursive) {
        const d = freshDir();
        dir.children.set(segs[i], d);
        dir = d;
      } else {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }
  }
  async readFile(path, options) {
    return fromBuffer(await this.readFileBytes(path), getEncoding(options));
  }
  async readFileBytes(path) {
    validatePath(path, "open");
    if (normalizePath(path) === "/") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }
    const loc = this.locate(path, true, "open");
    if (!loc)
      throw this.missing("open", path);
    if (loc.entry.kind === "dir" || loc.entry.kind === "symlink") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }
    if (loc.entry.kind === "lazy")
      return this.forceLazy(loc);
    return loc.entry.bytes;
  }
  async writeFile(path, content, options) {
    this.insertContent(path, content, getEncoding(options));
  }
  async writeFileBytes(path, content) {
    this.insertContent(path, content);
  }
  async appendFile(path, content) {
    validatePath(path, "append");
    const extra = typeof content === "string" ? utf8.encode(content) : content;
    const loc = this.locate(path, true, "append");
    if (loc?.entry.kind === "dir") {
      throw new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
    }
    if (!loc) {
      this.insertContent(path, content);
      return;
    }
    let existing;
    if (loc.entry.kind === "lazy") {
      existing = await this.forceLazy(loc);
    } else if (loc.entry.kind === "file") {
      existing = loc.entry.bytes;
    } else {
      this.insertContent(path, content);
      return;
    }
    const merged = new Uint8Array(existing.length + extra.length);
    merged.set(existing);
    merged.set(extra, existing.length);
    const fresh = loc.parent.children.get(loc.key);
    if (fresh && fresh.kind === "file") {
      fresh.bytes = merged;
      fresh.mtime = /* @__PURE__ */ new Date();
    }
  }
  async exists(path) {
    if (path.includes("\0"))
      return false;
    try {
      if (normalizePath(path) === "/")
        return true;
      return this.locate(path, true, "access") !== null;
    } catch {
      return false;
    }
  }
  async stat(path) {
    validatePath(path, "stat");
    if (normalizePath(path) === "/") {
      return {
        type: "directory",
        size: 0,
        mtime: this.tree.mtime,
        mode: this.tree.mode
      };
    }
    const loc = this.locate(path, true, "stat");
    if (!loc)
      throw this.missing("stat", path);
    if (loc.entry.kind === "lazy")
      await this.forceLazy(loc);
    const n = loc.parent.children.get(loc.key);
    if (!n)
      throw this.missing("stat", path);
    return {
      type: kindToType(n),
      size: nodeSize(n),
      mtime: n.mtime,
      mode: n.mode
    };
  }
  async lstat(path) {
    validatePath(path, "lstat");
    if (normalizePath(path) === "/") {
      return {
        type: "directory",
        size: 0,
        mtime: this.tree.mtime,
        mode: this.tree.mode
      };
    }
    const loc = this.locate(path, false, "lstat");
    if (!loc)
      throw this.missing("lstat", path);
    if (loc.entry.kind === "symlink") {
      return {
        type: "symlink",
        size: loc.entry.target.length,
        mtime: loc.entry.mtime,
        mode: loc.entry.mode
      };
    }
    if (loc.entry.kind === "lazy")
      await this.forceLazy(loc);
    const n = loc.parent.children.get(loc.key);
    if (!n)
      throw this.missing("lstat", path);
    return {
      type: kindToType(n),
      size: nodeSize(n),
      mtime: n.mtime,
      mode: n.mode
    };
  }
  async mkdir(path, options) {
    this.mkdirSync(path, options);
  }
  async readdir(path) {
    return (await this.readdirWithFileTypes(path)).map((d) => d.name);
  }
  async readdirWithFileTypes(path) {
    validatePath(path, "scandir");
    const dir = this.resolveNode(path, true, "scandir");
    if (!dir)
      throw this.missing("scandir", path);
    if (dir.kind !== "dir") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }
    const out = [];
    for (const [name, child] of dir.children) {
      out.push({ name, type: kindToType(child) });
    }
    return out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  async rm(path, options) {
    validatePath(path, "rm");
    const segs = split(normalizePath(path));
    if (segs.length === 0) {
      if (options?.force)
        return;
      throw new Error(`EPERM: cannot remove root, rm '${path}'`);
    }
    let dir = this.tree;
    for (let i = 0; i < segs.length - 1; i++) {
      const next = dir.children.get(segs[i]);
      if (!next || next.kind !== "dir") {
        if (options?.force)
          return;
        throw this.missing("rm", path);
      }
      dir = next;
    }
    const name = segs[segs.length - 1];
    const target = dir.children.get(name);
    if (!target) {
      if (options?.force)
        return;
      throw this.missing("rm", path);
    }
    if (target.kind === "dir" && target.children.size > 0 && !options?.recursive) {
      throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
    }
    dir.children.delete(name);
  }
  async cp(src, dest, options) {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    const srcNode = this.resolveNode(src, false, "cp");
    if (!srcNode)
      throw this.missing("cp", src);
    if (srcNode.kind === "dir" && !options?.recursive) {
      throw new Error(`EISDIR: is a directory, cp '${src}'`);
    }
    this.placeNode(normalizePath(dest), this.deepClone(srcNode));
  }
  async mv(src, dest) {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }
  async symlink(target, linkPath) {
    validatePath(linkPath, "symlink");
    const segs = split(normalizePath(linkPath));
    if (segs.length === 0) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }
    const parent = this.scaffold(segs);
    const name = segs[segs.length - 1];
    if (parent.children.has(name)) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }
    parent.children.set(name, {
      kind: "symlink",
      target,
      mode: SYMLINK_MODE,
      mtime: /* @__PURE__ */ new Date()
    });
  }
  async readlink(path) {
    validatePath(path, "readlink");
    const loc = this.locate(path, false, "readlink");
    if (!loc)
      throw this.missing("readlink", path);
    if (loc.entry.kind !== "symlink") {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }
    return loc.entry.target;
  }
  async realpath(path) {
    validatePath(path, "realpath");
    const canon = this.canonicalize(path);
    if (canon === null)
      throw this.missing("realpath", path);
    return canon;
  }
  resolvePath(base, path) {
    return resolvePath(base, path);
  }
  async glob(pattern) {
    const re = createGlobMatcher(pattern);
    const hits = [];
    this.gather(this.tree, "", re, hits);
    return sortPaths(hits);
  }
  resolveNode(rawPath, followLast, op) {
    if (normalizePath(rawPath) === "/")
      return this.tree;
    const loc = this.locate(rawPath, followLast, op);
    return loc ? loc.entry : null;
  }
  locate(rawPath, followLast, op) {
    const norm = normalizePath(rawPath);
    if (norm === "/")
      return null;
    const pending = split(norm);
    const trail = [];
    let dir = this.tree;
    let budget = MAX_SYMLINK_DEPTH;
    while (pending.length > 0) {
      const seg = pending.shift();
      const child = dir.children.get(seg);
      if (!child)
        return null;
      const last = pending.length === 0;
      if (child.kind === "symlink" && (!last || followLast)) {
        if (--budget < 0) {
          throw new Error(`ELOOP: too many levels of symbolic links, ${op} '${rawPath}'`);
        }
        const base = trail.length > 0 ? "/" + trail.join("/") : "";
        const abs = child.target.startsWith("/") ? normalizePath(child.target) : normalizePath(base + "/" + child.target);
        pending.unshift(...split(abs));
        trail.length = 0;
        dir = this.tree;
        continue;
      }
      if (last)
        return { entry: child, parent: dir, key: seg };
      if (child.kind !== "dir")
        return null;
      trail.push(seg);
      dir = child;
    }
    return null;
  }
  canonicalize(rawPath) {
    const norm = normalizePath(rawPath);
    if (norm === "/")
      return "/";
    const pending = split(norm);
    const resolved = [];
    let dir = this.tree;
    let budget = MAX_SYMLINK_DEPTH;
    while (pending.length > 0) {
      const seg = pending.shift();
      const child = dir.children.get(seg);
      if (!child)
        return null;
      if (child.kind === "symlink") {
        if (--budget < 0) {
          throw new Error(`ELOOP: too many levels of symbolic links, realpath '${rawPath}'`);
        }
        const base = resolved.length > 0 ? "/" + resolved.join("/") : "";
        const abs = child.target.startsWith("/") ? normalizePath(child.target) : normalizePath(base + "/" + child.target);
        pending.unshift(...split(abs));
        resolved.length = 0;
        dir = this.tree;
        continue;
      }
      resolved.push(seg);
      if (child.kind === "dir" && pending.length > 0) {
        dir = child;
      } else if (pending.length > 0) {
        return null;
      }
    }
    return "/" + resolved.join("/");
  }
  insertContent(rawPath, content, encoding, mode, mtime) {
    validatePath(rawPath, "write");
    const segs = split(normalizePath(rawPath));
    if (segs.length === 0) {
      throw new Error(`EISDIR: illegal operation on a directory, write '${rawPath}'`);
    }
    const parent = this.scaffold(segs);
    parent.children.set(segs[segs.length - 1], {
      kind: "file",
      bytes: toBuffer(content, encoding),
      mode: mode ?? DEFAULT_FILE_MODE,
      mtime: mtime ?? /* @__PURE__ */ new Date()
    });
  }
  insertLazy(rawPath, provider, mode, mtime) {
    validatePath(rawPath, "write");
    const segs = split(normalizePath(rawPath));
    if (segs.length === 0)
      return;
    const parent = this.scaffold(segs);
    parent.children.set(segs[segs.length - 1], {
      kind: "lazy",
      provider,
      mode: mode ?? DEFAULT_FILE_MODE,
      mtime: mtime ?? /* @__PURE__ */ new Date()
    });
  }
  async forceLazy(loc) {
    const lazy = loc.entry;
    const raw = await lazy.provider();
    const bytes = typeof raw === "string" ? utf8.encode(raw) : raw;
    loc.parent.children.set(loc.key, {
      kind: "file",
      bytes,
      mode: lazy.mode,
      mtime: lazy.mtime
    });
    return bytes;
  }
  scaffold(segs) {
    let dir = this.tree;
    for (let i = 0; i < segs.length - 1; i++) {
      const child = dir.children.get(segs[i]);
      if (child && child.kind === "dir") {
        dir = child;
      } else {
        const d = freshDir();
        dir.children.set(segs[i], d);
        dir = d;
      }
    }
    return dir;
  }
  placeNode(normalized, entry) {
    const segs = split(normalized);
    if (segs.length === 0) {
      throw new Error(`EISDIR: illegal operation on a directory, write '${normalized}'`);
    }
    const parent = this.scaffold(segs);
    parent.children.set(segs[segs.length - 1], entry);
  }
  deepClone(entry) {
    switch (entry.kind) {
      case "file":
        return {
          kind: "file",
          bytes: new Uint8Array(entry.bytes),
          mode: entry.mode,
          mtime: entry.mtime
        };
      case "lazy":
        return { ...entry };
      case "symlink":
        return { ...entry };
      case "dir": {
        const clone = {
          kind: "dir",
          children: /* @__PURE__ */ new Map(),
          mode: entry.mode,
          mtime: entry.mtime
        };
        for (const [k, v] of entry.children) {
          clone.children.set(k, this.deepClone(v));
        }
        return clone;
      }
    }
  }
  gather(dir, prefix, re, out) {
    for (const [name, child] of dir.children) {
      const full = prefix + "/" + name;
      if (re.test(full))
        out.push(full);
      if (child.kind === "dir")
        this.gather(child, full, re, out);
    }
  }
  missing(op, path) {
    return new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
  }
};

// ../../../packages/kuralle-fs/dist/okf.js
var RESERVED = /* @__PURE__ */ new Set(["index.md", "log.md"]);
var FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;
var LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
function parseOkfConcept(content, id) {
  const stripped = content.replace(/^﻿/, "");
  const match = stripped.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`OKF: concept "${id}" is missing YAML frontmatter.`);
  }
  const fm = parseFlatYaml(match[1] ?? "");
  const type = typeof fm.type === "string" ? fm.type.trim() : "";
  if (!type) {
    throw new Error(`OKF: concept "${id}" frontmatter must define a non-empty "type" (spec \xA79).`);
  }
  const body = (match[2] ?? "").replace(/^\n/, "");
  const links = extractBundleLinks(body);
  const concept = { id, type, body, links };
  const title = str(fm.title);
  const description = str(fm.description);
  const resource = str(fm.resource);
  const timestamp = str(fm.timestamp);
  if (title)
    concept.title = title;
  if (description)
    concept.description = description;
  if (resource)
    concept.resource = resource;
  if (Array.isArray(fm.tags))
    concept.tags = fm.tags.map(String);
  if (timestamp)
    concept.timestamp = timestamp;
  return concept;
}
async function listOkfConcepts(fs, root = "/") {
  const out = [];
  const stack = [root === "" ? "/" : root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdirWithFileTypes(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = fs.resolvePath(dir, entry.name);
      if (entry.type === "directory") {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".md") || RESERVED.has(entry.name))
        continue;
      const id = full.replace(/^\//, "").replace(/\.md$/, "");
      try {
        out.push(parseOkfConcept(await fs.readFile(full), id));
      } catch {
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : void 0;
}
function extractBundleLinks(body) {
  const links = /* @__PURE__ */ new Set();
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(body)) !== null) {
    const target = (m[1] ?? "").trim();
    if (target.startsWith("/") && target.endsWith(".md")) {
      links.add(target.replace(/\.md$/, "").replace(/^\//, ""));
    }
  }
  return [...links];
}
function parseFlatYaml(yaml) {
  const result = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const km = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!km) {
      i += 1;
      continue;
    }
    const key = km[1];
    const rest = (km[2] ?? "").trim();
    if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      result[key] = inner === "" ? [] : inner.split(",").map((s) => scalar(s.trim()));
      i += 1;
      continue;
    }
    if (rest === "") {
      i += 1;
      const items = [];
      while (i < lines.length && /^\s+-\s+/.test(lines[i])) {
        items.push(scalar(lines[i].replace(/^\s+-\s+/, "")));
        i += 1;
      }
      result[key] = items.length > 0 ? items : "";
      continue;
    }
    result[key] = scalar(rest);
    i += 1;
  }
  return result;
}
function scalar(v) {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"') || t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1);
  }
  return t;
}

// ../../../packages/kuralle-fs/dist/sql/sql-fs.js
var DEFAULT_INLINE_THRESHOLD = 15e5;
var VALID_NAMESPACE = /^[a-z][a-z0-9_]*$/i;
var TEXT_ENCODER = new TextEncoder();
function split2(normalized) {
  return normalized === "/" ? [] : normalized.slice(1).split("/");
}
function basename(path) {
  const norm = normalizePath(path);
  if (norm === "/")
    return "";
  return norm.slice(norm.lastIndexOf("/") + 1);
}
function bytesToBase64(bytes) {
  const chunk = 8192;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.byteLength)));
  }
  return btoa(binary);
}
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
function rowMtime(row) {
  return new Date(row.modified_at * 1e3);
}
function rowToStat(row) {
  return {
    type: row.type,
    size: row.type === "symlink" ? row.target?.length ?? 0 : row.size,
    mtime: rowMtime(row),
    mode: row.type === "directory" ? DEFAULT_DIR_MODE : row.type === "symlink" ? SYMLINK_MODE : DEFAULT_FILE_MODE
  };
}
var SqlFileSystem = class {
  backend;
  namespace;
  tableName;
  indexName;
  blobs;
  threshold;
  initPromise = null;
  constructor(opts) {
    const ns = opts.namespace ?? "default";
    if (!VALID_NAMESPACE.test(ns)) {
      throw new Error(`Invalid namespace "${ns}": must start with a letter and contain only alphanumeric characters or underscores`);
    }
    this.backend = opts.backend;
    this.namespace = ns;
    this.tableName = `${ns}_files`;
    this.indexName = `${ns}_files_parent`;
    this.blobs = opts.blobs;
    this.threshold = opts.inlineThreshold ?? DEFAULT_INLINE_THRESHOLD;
  }
  async init() {
    await this.ensureInit();
  }
  async ensureInit() {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }
  async doInit() {
    const T = this.tableName;
    const I = this.indexName;
    await this.backend.run(`
      CREATE TABLE IF NOT EXISTS ${T} (
        path            TEXT PRIMARY KEY,
        parent_path     TEXT NOT NULL,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL CHECK(type IN ('file','directory','symlink')),
        mime_type       TEXT NOT NULL DEFAULT 'text/plain',
        size            INTEGER NOT NULL DEFAULT 0,
        storage_backend TEXT NOT NULL DEFAULT 'inline' CHECK(storage_backend IN ('inline','blob')),
        blob_key        TEXT,
        target          TEXT,
        content_encoding TEXT NOT NULL DEFAULT 'utf8',
        content         TEXT,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        modified_at     INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    await this.backend.run(`CREATE INDEX IF NOT EXISTS ${I} ON ${T}(parent_path)`);
    const hasRoot = (await this.backend.query(`SELECT COUNT(*) AS cnt FROM ${T} WHERE path = '/'`))[0]?.cnt ?? 0;
    if (hasRoot === 0) {
      const now = Math.floor(Date.now() / 1e3);
      await this.backend.run(`INSERT INTO ${T}
          (path, parent_path, name, type, size, created_at, modified_at)
        VALUES ('/', '', '', 'directory', 0, ?, ?)`, now, now);
    }
  }
  missing(op, path) {
    return new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
  }
  blobKey(filePath) {
    return `${this.namespace}:${filePath}`;
  }
  async getRow(path) {
    const T = this.tableName;
    const rows = await this.backend.query(`SELECT path, parent_path, name, type, mime_type, size,
              storage_backend, blob_key, target, content_encoding, content,
              created_at, modified_at
       FROM ${T} WHERE path = ?`, path);
    return rows[0] ?? null;
  }
  async readBytesFromRow(row) {
    if (row.storage_backend === "blob" && row.blob_key) {
      if (!this.blobs) {
        throw new Error(`File ${row.path} is stored in blob but no BlobStore was provided`);
      }
      const data = await this.blobs.get(row.blob_key);
      return data ?? new Uint8Array(0);
    }
    if (row.content_encoding === "base64" && row.content) {
      return base64ToBytes(row.content);
    }
    return TEXT_ENCODER.encode(row.content ?? "");
  }
  async deleteBlobIfNeeded(row) {
    if (row.storage_backend === "blob" && row.blob_key && this.blobs) {
      await this.blobs.delete(row.blob_key);
    }
  }
  async insertDirectory(path) {
    const T = this.tableName;
    const parent = dirname(path);
    const name = basename(path);
    const now = Math.floor(Date.now() / 1e3);
    await this.backend.run(`INSERT INTO ${T}
        (path, parent_path, name, type, size, created_at, modified_at)
      VALUES (?, ?, ?, 'directory', 0, ?, ?)`, path, parent, name, now, now);
  }
  async scaffoldForPath(normalized) {
    const segs = split2(normalized);
    if (segs.length <= 1)
      return;
    let current = "/";
    for (let i = 0; i < segs.length - 1; i++) {
      const childPath = current === "/" ? `/${segs[i]}` : `${current}/${segs[i]}`;
      const row = await this.getRow(childPath);
      if (row) {
        if (row.type === "directory") {
          current = childPath;
          continue;
        }
        await this.deleteBlobIfNeeded(row);
        const T = this.tableName;
        await this.backend.run(`DELETE FROM ${T} WHERE path = ?`, childPath);
        await this.insertDirectory(childPath);
        current = childPath;
      } else {
        await this.insertDirectory(childPath);
        current = childPath;
      }
    }
  }
  async locate(rawPath, followLast, op) {
    const norm = normalizePath(rawPath);
    if (norm === "/")
      return null;
    const pending = [...split2(norm)];
    const trail = [];
    let budget = MAX_SYMLINK_DEPTH;
    while (pending.length > 0) {
      const seg = pending.shift();
      const currentPath = trail.length === 0 ? `/${seg}` : `/${trail.join("/")}/${seg}`;
      const row = await this.getRow(currentPath);
      if (!row)
        return null;
      const last = pending.length === 0;
      if (row.type === "symlink" && (!last || followLast)) {
        if (--budget < 0) {
          throw new Error(`ELOOP: too many levels of symbolic links, ${op} '${rawPath}'`);
        }
        const base = trail.length > 0 ? "/" + trail.join("/") : "";
        const abs = row.target.startsWith("/") ? normalizePath(row.target) : normalizePath(base === "/" ? `/${row.target}` : `${base}/${row.target}`);
        pending.unshift(...split2(abs));
        trail.length = 0;
        continue;
      }
      if (last)
        return row;
      if (row.type !== "directory")
        return null;
      trail.push(seg);
    }
    return null;
  }
  async canonicalize(rawPath) {
    const norm = normalizePath(rawPath);
    if (norm === "/")
      return "/";
    const pending = [...split2(norm)];
    const resolved = [];
    let budget = MAX_SYMLINK_DEPTH;
    while (pending.length > 0) {
      const seg = pending.shift();
      const currentPath = resolved.length === 0 ? `/${seg}` : `/${resolved.join("/")}/${seg}`;
      const row = await this.getRow(currentPath);
      if (!row)
        return null;
      if (row.type === "symlink") {
        if (--budget < 0) {
          throw new Error(`ELOOP: too many levels of symbolic links, realpath '${rawPath}'`);
        }
        const base = resolved.length > 0 ? "/" + resolved.join("/") : "";
        const abs = row.target.startsWith("/") ? normalizePath(row.target) : normalizePath(base === "/" ? `/${row.target}` : `${base}/${row.target}`);
        pending.unshift(...split2(abs));
        resolved.length = 0;
        continue;
      }
      resolved.push(seg);
      if (row.type !== "directory" && pending.length > 0)
        return null;
    }
    return "/" + resolved.join("/");
  }
  async readFile(path) {
    return fromBuffer(await this.readFileBytes(path));
  }
  async readFileBytes(path) {
    await this.ensureInit();
    validatePath(path, "open");
    if (normalizePath(path) === "/") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }
    const row = await this.locate(path, true, "open");
    if (!row)
      throw this.missing("open", path);
    if (row.type === "directory" || row.type === "symlink") {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }
    return this.readBytesFromRow(row);
  }
  async writeFile(path, content) {
    await this.ensureInit();
    validatePath(path, "write");
    const norm = normalizePath(path);
    if (norm === "/") {
      throw new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
    }
    await this.scaffoldForPath(norm);
    const bytes = TEXT_ENCODER.encode(content);
    const size = bytes.byteLength;
    const parent = dirname(norm);
    const name = basename(norm);
    const now = Math.floor(Date.now() / 1e3);
    const T = this.tableName;
    const existing = await this.getRow(norm);
    if (existing) {
      await this.deleteBlobIfNeeded(existing);
    }
    if (size >= this.threshold && this.blobs) {
      const key = this.blobKey(norm);
      await this.blobs.put(key, bytes);
      await this.backend.run(`INSERT INTO ${T}
          (path, parent_path, name, type, mime_type, size,
           storage_backend, blob_key, content_encoding, content, created_at, modified_at)
        VALUES (?, ?, ?, 'file', 'text/plain', ?, 'blob', ?, 'utf8', NULL, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          parent_path = excluded.parent_path,
          name = excluded.name,
          type = 'file',
          mime_type = excluded.mime_type,
          size = excluded.size,
          storage_backend = 'blob',
          blob_key = excluded.blob_key,
          content_encoding = 'utf8',
          content = NULL,
          modified_at = excluded.modified_at`, norm, parent, name, size, key, now, now);
      return;
    }
    await this.backend.run(`INSERT INTO ${T}
        (path, parent_path, name, type, mime_type, size,
         storage_backend, blob_key, content_encoding, content, created_at, modified_at)
      VALUES (?, ?, ?, 'file', 'text/plain', ?, 'inline', NULL, 'utf8', ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        parent_path = excluded.parent_path,
        name = excluded.name,
        type = 'file',
        mime_type = excluded.mime_type,
        size = excluded.size,
        storage_backend = 'inline',
        blob_key = NULL,
        content_encoding = 'utf8',
        content = excluded.content,
        modified_at = excluded.modified_at`, norm, parent, name, size, content, now, now);
  }
  async writeFileBytes(path, content) {
    await this.ensureInit();
    validatePath(path, "write");
    const norm = normalizePath(path);
    if (norm === "/") {
      throw new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
    }
    await this.scaffoldForPath(norm);
    const parent = dirname(norm);
    const name = basename(norm);
    const size = content.byteLength;
    const now = Math.floor(Date.now() / 1e3);
    const T = this.tableName;
    const existing = await this.getRow(norm);
    if (existing) {
      await this.deleteBlobIfNeeded(existing);
    }
    if (size >= this.threshold && this.blobs) {
      const key = this.blobKey(norm);
      await this.blobs.put(key, content);
      await this.backend.run(`INSERT INTO ${T}
          (path, parent_path, name, type, mime_type, size,
           storage_backend, blob_key, content_encoding, content, created_at, modified_at)
        VALUES (?, ?, ?, 'file', 'application/octet-stream', ?, 'blob', ?, 'base64', NULL, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          parent_path = excluded.parent_path,
          name = excluded.name,
          type = 'file',
          mime_type = excluded.mime_type,
          size = excluded.size,
          storage_backend = 'blob',
          blob_key = excluded.blob_key,
          content_encoding = 'base64',
          content = NULL,
          modified_at = excluded.modified_at`, norm, parent, name, size, key, now, now);
      return;
    }
    const b64 = bytesToBase64(content);
    await this.backend.run(`INSERT INTO ${T}
        (path, parent_path, name, type, mime_type, size,
         storage_backend, blob_key, content_encoding, content, created_at, modified_at)
      VALUES (?, ?, ?, 'file', 'application/octet-stream', ?, 'inline', NULL, 'base64', ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        parent_path = excluded.parent_path,
        name = excluded.name,
        type = 'file',
        mime_type = excluded.mime_type,
        size = excluded.size,
        storage_backend = 'inline',
        blob_key = NULL,
        content_encoding = 'base64',
        content = excluded.content,
        modified_at = excluded.modified_at`, norm, parent, name, size, b64, now, now);
  }
  async appendFile(path, content) {
    await this.ensureInit();
    validatePath(path, "append");
    const extra = typeof content === "string" ? TEXT_ENCODER.encode(content) : content;
    const row = await this.locate(path, true, "append");
    if (row?.type === "directory") {
      throw new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
    }
    if (!row) {
      await this.writeFileBytes(path, extra);
      return;
    }
    if (row.type === "symlink") {
      await this.writeFileBytes(path, extra);
      return;
    }
    const existing = await this.readBytesFromRow(row);
    const merged = new Uint8Array(existing.length + extra.length);
    merged.set(existing);
    merged.set(extra, existing.length);
    await this.writeFileBytes(row.path, merged);
  }
  async exists(path) {
    await this.ensureInit();
    if (path.includes("\0"))
      return false;
    try {
      if (normalizePath(path) === "/")
        return true;
      return await this.locate(path, true, "access") !== null;
    } catch {
      return false;
    }
  }
  async stat(path) {
    await this.ensureInit();
    validatePath(path, "stat");
    if (normalizePath(path) === "/") {
      const root = await this.getRow("/");
      return {
        type: "directory",
        size: 0,
        mtime: root ? rowMtime(root) : /* @__PURE__ */ new Date(),
        mode: DEFAULT_DIR_MODE
      };
    }
    const row = await this.locate(path, true, "stat");
    if (!row)
      throw this.missing("stat", path);
    return rowToStat(row);
  }
  async lstat(path) {
    await this.ensureInit();
    validatePath(path, "lstat");
    if (normalizePath(path) === "/") {
      const root = await this.getRow("/");
      return {
        type: "directory",
        size: 0,
        mtime: root ? rowMtime(root) : /* @__PURE__ */ new Date(),
        mode: DEFAULT_DIR_MODE
      };
    }
    const row = await this.locate(path, false, "lstat");
    if (!row)
      throw this.missing("lstat", path);
    if (row.type === "symlink") {
      return {
        type: "symlink",
        size: row.target?.length ?? 0,
        mtime: rowMtime(row),
        mode: SYMLINK_MODE
      };
    }
    return rowToStat(row);
  }
  async mkdir(path, options) {
    await this.ensureInit();
    validatePath(path, "mkdir");
    const norm = normalizePath(path);
    if (norm === "/") {
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return;
    }
    const existing = await this.getRow(norm);
    if (existing) {
      if (existing.type === "directory") {
        if (!options?.recursive) {
          throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
        }
        return;
      }
      throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
    }
    const segs = split2(norm);
    let dirPath = "/";
    for (let i = 0; i < segs.length; i++) {
      const last = i === segs.length - 1;
      const childPath = dirPath === "/" ? `/${segs[i]}` : `${dirPath}/${segs[i]}`;
      const child = await this.getRow(childPath);
      if (child) {
        if (child.type === "directory") {
          if (last) {
            if (!options?.recursive) {
              throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
            }
            return;
          }
          dirPath = childPath;
        } else if (last) {
          throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
        } else if (options?.recursive) {
          await this.deleteBlobIfNeeded(child);
          const T = this.tableName;
          await this.backend.run(`DELETE FROM ${T} WHERE path = ?`, childPath);
          await this.insertDirectory(childPath);
          dirPath = childPath;
        } else {
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }
      } else if (last) {
        await this.insertDirectory(childPath);
      } else if (options?.recursive) {
        await this.insertDirectory(childPath);
        dirPath = childPath;
      } else {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }
  }
  async readdir(path) {
    return (await this.readdirWithFileTypes(path)).map((d) => d.name);
  }
  async readdirWithFileTypes(path) {
    await this.ensureInit();
    validatePath(path, "scandir");
    const norm = normalizePath(path);
    const row = await this.locate(path, true, "scandir");
    if (!row)
      throw this.missing("scandir", path);
    if (row.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }
    const T = this.tableName;
    const rows = await this.backend.query(`SELECT name, type FROM ${T} WHERE parent_path = ? ORDER BY name`, norm);
    return rows.map((r) => ({
      name: r.name,
      type: r.type
    }));
  }
  async rm(path, options) {
    await this.ensureInit();
    validatePath(path, "rm");
    const norm = normalizePath(path);
    if (norm === "/") {
      if (options?.force)
        return;
      throw new Error(`EPERM: cannot remove root, rm '${path}'`);
    }
    const row = await this.getRow(norm);
    if (!row) {
      if (options?.force)
        return;
      throw this.missing("rm", path);
    }
    if (row.type === "directory") {
      const T2 = this.tableName;
      const children = await this.backend.query(`SELECT COUNT(*) AS cnt FROM ${T2} WHERE parent_path = ?`, norm);
      if ((children[0]?.cnt ?? 0) > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
        await this.deleteDescendants(norm);
      }
    } else {
      await this.deleteBlobIfNeeded(row);
    }
    const T = this.tableName;
    await this.backend.run(`DELETE FROM ${T} WHERE path = ?`, norm);
  }
  async deleteDescendants(dirPath) {
    const T = this.tableName;
    const pattern = `${dirPath}/%`;
    const blobRows = await this.backend.query(`SELECT blob_key FROM ${T}
       WHERE path LIKE ?
         AND storage_backend = 'blob'
         AND blob_key IS NOT NULL`, pattern);
    if (this.blobs) {
      for (const r of blobRows) {
        await this.blobs.delete(r.blob_key);
      }
    }
    await this.backend.run(`DELETE FROM ${T} WHERE path LIKE ?`, pattern);
  }
  async cp(src, dest, options) {
    await this.ensureInit();
    validatePath(src, "cp");
    validatePath(dest, "cp");
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcRow = await this.locate(src, false, "cp");
    if (!srcRow)
      throw this.missing("cp", src);
    if (srcRow.type === "symlink") {
      await this.symlink(srcRow.target, dest);
      return;
    }
    if (srcRow.type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(destNorm, { recursive: true });
      const children = await this.readdirWithFileTypes(srcNorm);
      for (const child of children) {
        const childSrc = srcNorm === "/" ? `/${child.name}` : `${srcNorm}/${child.name}`;
        const childDest = destNorm === "/" ? `/${child.name}` : `${destNorm}/${child.name}`;
        await this.cp(childSrc, childDest, options);
      }
      return;
    }
    const bytes = await this.readFileBytes(srcNorm);
    await this.writeFileBytes(destNorm, bytes);
  }
  async mv(src, dest) {
    await this.ensureInit();
    validatePath(src, "mv");
    validatePath(dest, "mv");
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcRow = await this.locate(src, false, "mv");
    if (!srcRow)
      throw this.missing("mv", src);
    if (srcRow.type === "directory") {
      await this.cp(src, dest, { recursive: true });
      await this.rm(src, { recursive: true });
      return;
    }
    const destParent = dirname(destNorm);
    const destName = basename(destNorm);
    await this.scaffoldForPath(destNorm);
    const existingDest = await this.getRow(destNorm);
    if (existingDest) {
      await this.deleteBlobIfNeeded(existingDest);
      const T2 = this.tableName;
      await this.backend.run(`DELETE FROM ${T2} WHERE path = ?`, destNorm);
    }
    const now = Math.floor(Date.now() / 1e3);
    const T = this.tableName;
    if (srcRow.type === "file" && srcRow.storage_backend === "blob" && srcRow.blob_key) {
      await this.backend.run(`UPDATE ${T} SET
          path = ?,
          parent_path = ?,
          name = ?,
          modified_at = ?
        WHERE path = ?`, destNorm, destParent, destName, now, srcNorm);
      return;
    }
    await this.backend.run(`UPDATE ${T} SET
        path = ?,
        parent_path = ?,
        name = ?,
        modified_at = ?
      WHERE path = ?`, destNorm, destParent, destName, now, srcNorm);
  }
  async symlink(target, linkPath) {
    await this.ensureInit();
    validatePath(linkPath, "symlink");
    const norm = normalizePath(linkPath);
    const segs = split2(norm);
    if (segs.length === 0) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }
    await this.scaffoldForPath(norm);
    const existing = await this.getRow(norm);
    if (existing) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }
    const parent = dirname(norm);
    const name = basename(norm);
    const now = Math.floor(Date.now() / 1e3);
    const T = this.tableName;
    await this.backend.run(`INSERT INTO ${T}
        (path, parent_path, name, type, target, size, created_at, modified_at)
      VALUES (?, ?, ?, 'symlink', ?, 0, ?, ?)`, norm, parent, name, target, now, now);
  }
  async readlink(path) {
    await this.ensureInit();
    validatePath(path, "readlink");
    const row = await this.locate(path, false, "readlink");
    if (!row)
      throw this.missing("readlink", path);
    if (row.type !== "symlink" || !row.target) {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }
    return row.target;
  }
  async realpath(path) {
    await this.ensureInit();
    validatePath(path, "realpath");
    const canon = await this.canonicalize(path);
    if (canon === null)
      throw this.missing("realpath", path);
    return canon;
  }
  resolvePath(base, path) {
    return resolvePath(base, path);
  }
  async glob(pattern) {
    await this.ensureInit();
    const re = createGlobMatcher(pattern);
    const T = this.tableName;
    const rows = await this.backend.query(`SELECT path FROM ${T}`);
    const hits = rows.map((r) => r.path).filter((p) => re.test(p));
    return sortPaths(hits);
  }
};

// ../../../packages/kuralle-fs/dist/sql/factory.js
function isSqlStorage(src) {
  return typeof src === "object" && src !== null && "databaseSize" in src;
}
function isD1(src) {
  return typeof src === "object" && src !== null && "prepare" in src && "batch" in src;
}
function toSqlBackend(src) {
  if (isSqlStorage(src)) {
    return {
      query: (sql, ...params) => [...src.exec(sql, ...params)],
      run: (sql, ...params) => {
        src.exec(sql, ...params);
      }
    };
  }
  if (isD1(src)) {
    return {
      query: async (sql, ...params) => {
        const r = await src.prepare(sql).bind(...params).all();
        return r.results;
      },
      run: async (sql, ...params) => {
        await src.prepare(sql).bind(...params).run();
      }
    };
  }
  return src;
}
function sqlFileSystem(source, options) {
  return new SqlFileSystem({ backend: toSqlBackend(source), ...options });
}

// ../../../packages/kuralle-fs/dist/sql/libsql-http.js
function toCell(v) {
  if (v === null || v === void 0)
    return { type: "null" };
  if (typeof v === "boolean")
    return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  }
  return { type: "text", value: v };
}
function fromCell(c) {
  switch (c.type) {
    case "null":
      return null;
    case "integer":
      return Number(c.value);
    case "float":
      return typeof c.value === "number" ? c.value : Number(c.value);
    case "text":
    case "blob":
      return String(c.value ?? c.base64 ?? "");
    default:
      return null;
  }
}
function libsqlHttpBackend(opts) {
  const base = opts.url.replace(/^libsql:\/\//, "https://").replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  async function pipeline(sql, args) {
    const res = await doFetch(`${base}/v2/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.authToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requests: [
          { type: "execute", stmt: { sql, args: args.map(toCell) } },
          { type: "close" }
        ]
      })
    });
    if (!res.ok) {
      throw new Error(`libsql HTTP ${res.status}: ${await res.text()}`);
    }
    const body = await res.json();
    const first = body.results[0];
    if (!first || first.type === "error") {
      throw new Error(`libsql: ${first?.error?.message ?? "unknown error"}`);
    }
    const result = first.response?.result ?? { cols: [], rows: [] };
    return { cols: result.cols.map((c) => c.name), rows: result.rows };
  }
  return {
    query: async (sql, ...args) => {
      const { cols, rows } = await pipeline(sql, args);
      return rows.map((row) => {
        const obj = {};
        cols.forEach((name, i) => {
          obj[name] = fromCell(row[i] ?? { type: "null" });
        });
        return obj;
      });
    },
    run: async (sql, ...args) => {
      await pipeline(sql, args);
    }
  };
}

// src/handler.ts
function workspace() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (url && authToken) {
    return { fs: sqlFileSystem(libsqlHttpBackend({ url, authToken })), persistent: true };
  }
  return { fs: new InMemoryFs(), persistent: false };
}
var PAGE = `<!doctype html><meta charset=utf-8><title>kuralle-fs on Vercel</title>
<style>body{font:15px/1.5 system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem}code,pre{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}pre{padding:1rem;overflow:auto}</style>
<h1>kuralle-fs \u2014 persistent workspace on Vercel (Turso / libSQL)</h1>
<p>A <code>SqlFileSystem</code> over a hosted Turso database. Vercel functions are
stateless, so persistence lives in Turso \u2014 files written in one request survive for
the next. Same backend story as Cloudflare, where the handle is a Durable Object's
<code>ctx.storage.sql</code>.</p>
<pre>curl -X POST "$URL/api/write" -H 'content-type: application/json' -d '{"path":"/kb/hours.md","content":"Open 9-5"}'
curl "$URL/api/read?path=/kb/hours.md"    # persisted in Turso
curl "$URL/api/ls?path=/kb"</pre>`;
var OKF = {
  "/index.md": "# Sales\n* [Orders](/tables/orders.md)\n* [WAU](/metrics/wau.md)",
  "/tables/orders.md": "---\ntype: BigQuery Table\ntitle: Orders\ndescription: One row per order.\n---\n# Schema\norder_id, customer_id.",
  "/metrics/wau.md": "---\ntype: Metric\ntitle: Weekly Active Users\ndescription: Distinct users in 7 days.\n---\n# Definition\nCOUNT(DISTINCT user_id) over events."
};
async function handler(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (data, status = 200) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data, null, 2));
  };
  if (url.pathname === "/" || url.pathname === "") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE.replaceAll("$URL", `https://${req.headers.host ?? ""}`));
    return;
  }
  try {
    const { fs, persistent } = workspace();
    if (url.pathname === "/api/write" && req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { path, content } = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (!path || content === void 0) return send({ error: "path and content required" }, 400);
      const dir = String(path).replace(/\/[^/]*$/, "") || "/";
      if (dir !== "/") await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path, content);
      return send({ ok: true, persistent, wrote: path, bytes: String(content).length });
    }
    if (url.pathname === "/api/read") {
      const path = url.searchParams.get("path");
      if (!path) return send({ error: "path required" }, 400);
      return send({ path, persistent, content: await fs.readFile(path) });
    }
    if (url.pathname === "/api/ls") {
      const path = url.searchParams.get("path") ?? "/";
      return send({ path, persistent, entries: await fs.readdir(path) });
    }
    if (url.pathname === "/api/concepts") {
      const okfFs = new InMemoryFs(OKF);
      return send({ concepts: await listOkfConcepts(okfFs) });
    }
  } catch (err) {
    return send({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
  send({ error: "not found" }, 404);
}
export {
  handler as default
};
