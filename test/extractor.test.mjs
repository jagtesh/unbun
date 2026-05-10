import assert from "node:assert/strict";
import { test } from "node:test";
import { extractExecutable } from "../src/extractor.mjs";

test("extracts modules from a synthetic Bun standalone graph appended to a host binary", () => {
  const executable = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), makeGraph()]);
  const result = extractExecutable(executable, { executablePath: "/tmp/app" });

  assert.equal(result.binaryFormat, "elf");
  assert.equal(result.graph.entryPointId, 0);
  assert.equal(result.graph.compileExecArgv, "--smol");
  assert.equal(result.modules.length, 2);
  assert.equal(result.modules[0].name, "/$bunfs/root/index.js");
  assert.equal(result.modules[0].safeRelativePath, "index.js");
  assert.equal(result.modules[0].contents.toString(), "console.log('hello')\n");
  assert.equal(result.modules[0].loader, "js");
  assert.equal(result.modules[0].moduleFormat, "esm");
  assert.equal(result.modules[1].safeRelativePath, "data/config.json");
  assert.equal(result.modules[1].contents.toString(), "{\"ok\":true}\n");
});

test("rejects binaries without the Bun trailer", () => {
  assert.throws(
    () => extractExecutable(Buffer.from("not a standalone executable")),
    /Bun standalone trailer not found/,
  );
});

function makeGraph() {
  const chunks = [];
  const modules = [];

  const add = (value, z = false) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const offset = Buffer.concat(chunks).length;
    chunks.push(z ? Buffer.concat([bytes, Buffer.from([0])]) : bytes);
    return { offset, length: bytes.length };
  };

  modules.push({
    name: add("/$bunfs/root/index.js", true),
    contents: add("console.log('hello')\n", true),
    sourcemap: ptr(),
    bytecode: ptr(),
    moduleInfo: ptr(),
    bytecodeOriginPath: ptr(),
    encoding: 1,
    loader: 1,
    moduleFormat: 1,
    side: 0,
  });
  modules.push({
    name: add("/$bunfs/root/data/config.json", true),
    contents: add("{\"ok\":true}\n", true),
    sourcemap: ptr(),
    bytecode: ptr(),
    moduleInfo: ptr(),
    bytecodeOriginPath: ptr(),
    encoding: 0,
    loader: 6,
    moduleFormat: 0,
    side: 0,
  });

  const argv = add("--smol", true);
  const records = Buffer.concat([
    ...modules.map(encodeModule),
  ]);
  const modulesPtr = add(records);
  const payload = Buffer.concat(chunks);
  const offsets = Buffer.alloc(32);
  offsets.writeBigUInt64LE(BigInt(payload.length), 0);
  writePtr(offsets, 8, modulesPtr);
  offsets.writeUInt32LE(0, 16);
  writePtr(offsets, 20, argv);
  offsets.writeUInt32LE(0, 28);

  return Buffer.concat([payload, offsets, Buffer.from("\n---- Bun! ----\n")]);
}

function encodeModule(module) {
  const out = Buffer.alloc(52);
  writePtr(out, 0, module.name);
  writePtr(out, 8, module.contents);
  writePtr(out, 16, module.sourcemap);
  writePtr(out, 24, module.bytecode);
  writePtr(out, 32, module.moduleInfo);
  writePtr(out, 40, module.bytecodeOriginPath);
  out[48] = module.encoding;
  out[49] = module.loader;
  out[50] = module.moduleFormat;
  out[51] = module.side;
  return out;
}

function writePtr(buffer, offset, pointer) {
  buffer.writeUInt32LE(pointer.offset, offset);
  buffer.writeUInt32LE(pointer.length, offset + 4);
}

function ptr() {
  return { offset: 0, length: 0 };
}
