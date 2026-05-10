const TRAILER = Buffer.from("\n---- Bun! ----\n");
const OFFSETS_SIZE = 32;
const MODULE_RECORD_SIZE = 52;

const LOADERS = {
  0: "jsx",
  1: "js",
  2: "ts",
  3: "tsx",
  4: "css",
  5: "file",
  6: "json",
  7: "jsonc",
  8: "toml",
  9: "wasm",
  10: "napi",
  11: "base64",
  12: "dataurl",
  13: "text",
  14: "bunsh",
  15: "sqlite",
  16: "sqlite_embedded",
  17: "html",
  18: "yaml",
};

const ENCODINGS = { 0: "binary", 1: "latin1", 2: "utf8" };
const MODULE_FORMATS = { 0: "none", 1: "esm", 2: "cjs" };
const SIDES = { 0: "server", 1: "client" };
const DEFAULT_EXTENSIONS = {
  jsx: ".jsx",
  js: ".js",
  ts: ".ts",
  tsx: ".tsx",
  css: ".css",
  file: ".bin",
  json: ".json",
  jsonc: ".jsonc",
  toml: ".toml",
  wasm: ".wasm",
  napi: ".node",
  base64: ".b64",
  dataurl: ".txt",
  text: ".txt",
  bunsh: ".bunsh",
  sqlite: ".sqlite",
  sqlite_embedded: ".sqlite",
  html: ".html",
  yaml: ".yaml",
};

export function extractExecutable(input, options = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const binaryFormat = detectBinaryFormat(bytes);
  const graph = findStandaloneGraph(bytes);
  const payload = bytes.subarray(graph.startOffset, graph.offsetsOffset);
  const modules = parseModules(payload, graph.offsets);

  return {
    binaryFormat,
    graph: {
      startOffset: graph.startOffset,
      offsetsOffset: graph.offsetsOffset,
      trailerOffset: graph.trailerOffset,
      byteCount: graph.offsets.byteCount,
      entryPointId: graph.offsets.entryPointId,
      compileExecArgv: readCString(payload, graph.offsets.compileExecArgv),
      flags: decodeFlags(graph.offsets.flags),
      hasBytecode: modules.some((mod) => mod.bytecode?.length),
      executablePath: options.executablePath,
    },
    modules,
  };
}

export function findStandaloneGraph(bytes) {
  const trailerOffset = lastIndexOfBuffer(bytes, TRAILER);
  if (trailerOffset < 0) {
    throw new Error("Bun standalone trailer not found; this does not look like a bun build --compile executable");
  }

  const offsetsOffset = trailerOffset - OFFSETS_SIZE;
  if (offsetsOffset < 0) throw new Error("corrupt Bun standalone graph: missing offsets before trailer");

  const offsets = readOffsets(bytes, offsetsOffset);
  const startOffset = offsetsOffset - offsets.byteCount;
  if (startOffset < 0) throw new Error("corrupt Bun standalone graph: byte_count points before start of file");
  if (offsets.modules.offset >= offsets.byteCount) {
    throw new Error("corrupt Bun standalone graph: module list offset is outside the payload");
  }

  return { startOffset, offsetsOffset, trailerOffset, offsets };
}

export function parseModules(payload, offsets) {
  const modulesStart = offsets.modules.offset;
  const modulesLength = offsets.modules.length;
  if (modulesStart + modulesLength > payload.length) {
    throw new Error("corrupt Bun standalone graph: module list extends beyond payload");
  }
  if (modulesLength < MODULE_RECORD_SIZE) {
    throw new Error("corrupt Bun standalone graph: module list is too small");
  }

  const headerSize = moduleListHeaderSize(modulesLength);
  const count = Math.floor((modulesLength - headerSize) / MODULE_RECORD_SIZE);
  const modules = [];
  for (let index = 0; index < count; index++) {
    const base = modulesStart + headerSize + index * MODULE_RECORD_SIZE;
    const record = readModuleRecord(payload, base);
    const loader = LOADERS[record.loader] ?? `loader${record.loader}`;
    const name = readCString(payload, record.name) || `/$bunfs/root/module_${index}${DEFAULT_EXTENSIONS[loader] ?? ".bin"}`;
    modules.push({
      index,
      name,
      safeRelativePath: safeRelativePath(name, index, loader),
      loader,
      encoding: ENCODINGS[record.encoding] ?? `encoding${record.encoding}`,
      moduleFormat: MODULE_FORMATS[record.moduleFormat] ?? `format${record.moduleFormat}`,
      side: SIDES[record.side] ?? `side${record.side}`,
      contents: readSlice(payload, record.contents),
      sourcemap: readOptionalSlice(payload, record.sourcemap),
      bytecode: readOptionalSlice(payload, record.bytecode),
      moduleInfo: readOptionalSlice(payload, record.moduleInfo),
      bytecodeOriginPath: readCString(payload, record.bytecodeOriginPath),
    });
  }
  return modules;
}

function moduleListHeaderSize(modulesLength) {
  if (modulesLength % MODULE_RECORD_SIZE === 0) return 0;
  if (modulesLength >= 8 && (modulesLength - 8) % MODULE_RECORD_SIZE === 0) return 8;
  throw new Error(`corrupt Bun standalone graph: module list length ${modulesLength} is not a valid record table`);
}

function readOffsets(bytes, offset) {
  return {
    byteCount: readUsize64(bytes, offset),
    modules: readStringPointer(bytes, offset + 8),
    entryPointId: bytes.readUInt32LE(offset + 16),
    compileExecArgv: readStringPointer(bytes, offset + 20),
    flags: bytes.readUInt32LE(offset + 28),
  };
}

function readModuleRecord(bytes, offset) {
  return {
    name: readStringPointer(bytes, offset),
    contents: readStringPointer(bytes, offset + 8),
    sourcemap: readStringPointer(bytes, offset + 16),
    bytecode: readStringPointer(bytes, offset + 24),
    moduleInfo: readStringPointer(bytes, offset + 32),
    bytecodeOriginPath: readStringPointer(bytes, offset + 40),
    encoding: bytes[offset + 48],
    loader: bytes[offset + 49],
    moduleFormat: bytes[offset + 50],
    side: bytes[offset + 51],
  };
}

function readStringPointer(bytes, offset) {
  return {
    offset: bytes.readUInt32LE(offset),
    length: bytes.readUInt32LE(offset + 4),
  };
}

function readUsize64(bytes, offset) {
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Bun graph offset is too large for JavaScript safe integers: ${value}`);
  }
  return Number(value);
}

function readSlice(bytes, pointer) {
  if (!pointer.length) return Buffer.alloc(0);
  if (pointer.offset + pointer.length > bytes.length) {
    throw new Error(`corrupt Bun standalone graph: slice ${pointer.offset}+${pointer.length} is outside the payload`);
  }
  return bytes.subarray(pointer.offset, pointer.offset + pointer.length);
}

function readOptionalSlice(bytes, pointer) {
  return pointer.length ? readSlice(bytes, pointer) : undefined;
}

function readCString(bytes, pointer) {
  const slice = readSlice(bytes, pointer);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul >= 0 ? nul : slice.length).toString("utf8");
}

function decodeFlags(flags) {
  return {
    raw: flags,
    disableDefaultEnvFiles: Boolean(flags & 1),
    disableAutoloadBunfig: Boolean(flags & 2),
    disableAutoloadTsconfig: Boolean(flags & 4),
    disableAutoloadPackageJson: Boolean(flags & 8),
  };
}

function detectBinaryFormat(bytes) {
  if (bytes.length >= 4) {
    const magic = bytes.readUInt32LE(0);
    if (magic === 0xfeedfacf) return "mach-o-64";
    if (magic === 0xcffaedfe) return "mach-o-64-big-endian";
    if (magic === 0xcafebabe || magic === 0xbebafeca) return "mach-o-fat";
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return "elf";
  if (bytes.subarray(0, 2).toString("latin1") === "MZ") return "pe";
  return "unknown";
}

function safeRelativePath(name, index, loader) {
  let rel = name
    .replace(/^\/\$bunfs\/(?:root\/)?/, "")
    .replace(/^B:[/\\]~BUN[/\\](?:root[/\\])?/i, "")
    .replace(/\\/g, "/");

  rel = rel.replace(/^\/+/, "");
  const parts = [];
  for (const part of rel.split("/")) {
    if (!part || part === "." || part === "..") continue;
    parts.push(part.replace(/[\0:*?"<>|]/g, "_"));
  }

  rel = parts.join("/");
  if (!rel) rel = `module_${index}${DEFAULT_EXTENSIONS[loader] ?? ".bin"}`;
  if (!/\.[^/.]+$/.test(rel)) rel += DEFAULT_EXTENSIONS[loader] ?? ".bin";
  return rel;
}

function lastIndexOfBuffer(haystack, needle) {
  for (let i = haystack.length - needle.length; i >= 0; i--) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}
