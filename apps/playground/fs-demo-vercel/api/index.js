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
function okfBundleToFs(files, mountRoot = "") {
  const seeded = {};
  for (const [path, content] of Object.entries(files)) {
    const p = path.startsWith("/") ? path : `/${path}`;
    seeded[`${mountRoot}${p}`] = content;
  }
  return new InMemoryFs(seeded);
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

// src/handler.ts
var BUNDLE = {
  "/index.md": "# Sales\n* [Orders](/tables/orders.md) - one row per order.\n* [Events](/tables/events.md) - product events.\n* [WAU](/metrics/weekly_active_users.md) - the metric.",
  "/tables/orders.md": "---\ntype: BigQuery Table\ntitle: Orders\ndescription: One row per completed order.\ntags: [sales]\n---\n\n# Schema\n| Column | Type | Description |\n|---|---|---|\n| order_id | STRING | Unique id. |\n| customer_id | STRING | FK to [customers](/tables/customers.md). |",
  "/tables/events.md": "---\ntype: BigQuery Table\ntitle: Events\ndescription: Raw product event stream.\ntags: [product]\n---\n\n# Schema\nThe identity/join key for activity is `user_id`. Feeds [WAU](/metrics/weekly_active_users.md).",
  "/tables/customers.md": "---\ntype: BigQuery Table\ntitle: Customers\ndescription: One row per customer.\n---\n\n# Schema\ncustomer_id STRING.",
  "/metrics/weekly_active_users.md": "---\ntype: Metric\ntitle: Weekly Active Users\ndescription: Distinct users with an event in a 7-day window.\n---\n\n# Definition\nCOUNT(DISTINCT user_id) over [events](/tables/events.md), trailing 7-day window."
};
var PAGE = `<!doctype html><meta charset=utf-8><title>kuralle-fs on Vercel</title>
<style>body{font:15px/1.5 system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem}code,pre{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}pre{padding:1rem;overflow:auto}</style>
<h1>kuralle-fs \u2014 portable workspace + OKF on Vercel</h1>
<p>An <code>InMemoryFs</code> workspace holding an Open Knowledge Format bundle, navigated with the same fs primitives that run on Node and Cloudflare.</p>
<pre>curl "$URL/api/concepts"
curl "$URL/api/read?path=/metrics/weekly_active_users.md"
curl "$URL/api/grep?q=user_id"</pre>
<p>Vercel functions are stateless; for persistence point <code>sqlFileSystem</code> at a hosted SQLite (Turso). On Cloudflare that handle is a Durable Object's <code>ctx.storage.sql</code>.</p>`;
async function grep(fs, q) {
  const re = new RegExp(q, "i");
  const hits = [];
  for (const path of await fs.glob("/**/*.md")) {
    const lines = (await fs.readFile(path)).split("\n");
    lines.forEach((text, i) => {
      if (re.test(text)) hits.push({ path, line: i + 1, text: text.slice(0, 120) });
    });
  }
  return hits;
}
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
    const fs = okfBundleToFs(BUNDLE);
    if (url.pathname === "/api/concepts") {
      return send({ concepts: await listOkfConcepts(fs) });
    }
    if (url.pathname === "/api/read") {
      const path = url.searchParams.get("path");
      if (!path) return send({ error: "path required" }, 400);
      return send({ path, content: await fs.readFile(path) });
    }
    if (url.pathname === "/api/grep") {
      const q = url.searchParams.get("q");
      if (!q) return send({ error: "q required" }, 400);
      return send({ q, hits: await grep(fs, q) });
    }
  } catch (err) {
    return send({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
  send({ error: "not found" }, 404);
}
export {
  handler as default
};
