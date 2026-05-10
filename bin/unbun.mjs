#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractExecutable } from "../src/extractor.mjs";

function usage() {
  console.log(`Usage: unbun <compiled-bun-executable> [options]

Extracts the embedded Bun StandaloneModuleGraph from a binary produced by:
  bun build --compile ./entry.ts --outfile app

Options:
  -o, --out DIR       Output directory (default: <exe-name>.unbun)
  -f, --force         Remove an existing output directory first
  --no-bytecode       Do not write .jsc bytecode blobs
  --no-sourcemaps     Do not write extracted sourcemaps
  --no-module-info    Do not write ESM bytecode module-info blobs
  --manifest-only     Only write manifest.json
  -h, --help          Show this help

Notes:
  Bun stores bundled JavaScript/TypeScript output, assets, sourcemaps, and
  optional JavaScriptCore bytecode. This tool can recover those embedded
  payloads. It cannot reverse minification or decompile bytecode into the
  original author-written source when Bun did not embed that source.
`);
}

function parseArgs(argv) {
  const args = {
    executable: undefined,
    outDir: undefined,
    force: false,
    writeBytecode: true,
    writeSourcemaps: true,
    writeModuleInfo: true,
    manifestOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "-f" || arg === "--force") {
      args.force = true;
    } else if (arg === "--no-bytecode") {
      args.writeBytecode = false;
    } else if (arg === "--no-sourcemaps") {
      args.writeSourcemaps = false;
    } else if (arg === "--no-module-info") {
      args.writeModuleInfo = false;
    } else if (arg === "--manifest-only") {
      args.manifestOnly = true;
    } else if (arg === "-o" || arg === "--out") {
      args.outDir = argv[++i];
      if (!args.outDir) throw new Error(`${arg} requires a directory`);
    } else if (arg.startsWith("--out=")) {
      args.outDir = arg.slice("--out=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (!args.executable) {
      args.executable = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  return args;
}

function defaultOutDir(executable) {
  const base = path.basename(executable).replace(/\.exe$/i, "");
  return path.resolve(`${base}.unbun`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (!args.executable) {
    usage();
    process.exitCode = 2;
    return;
  }

  const executable = path.resolve(args.executable);
  const outDir = path.resolve(args.outDir ?? defaultOutDir(executable));

  if (existsSync(outDir)) {
    if (!args.force) {
      throw new Error(`output directory already exists: ${outDir} (use --force)`);
    }
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  const buffer = await readFile(executable);
  const result = extractExecutable(buffer, { executablePath: executable });

  const filesDir = path.join(outDir, "files");
  if (!args.manifestOnly) await mkdir(filesDir, { recursive: true });

  const manifest = {
    tool: "unbun",
    extractedAt: new Date().toISOString(),
    executable,
    binaryFormat: result.binaryFormat,
    graph: result.graph,
    modules: [],
  };

  for (const mod of result.modules) {
    const relPath = mod.safeRelativePath;
    const target = path.join(filesDir, relPath);
    const entry = {
      index: mod.index,
      name: mod.name,
      path: relPath,
      loader: mod.loader,
      encoding: mod.encoding,
      moduleFormat: mod.moduleFormat,
      side: mod.side,
      contentsLength: mod.contents.length,
      sourcemapLength: mod.sourcemap?.length ?? 0,
      bytecodeLength: mod.bytecode?.length ?? 0,
      moduleInfoLength: mod.moduleInfo?.length ?? 0,
      bytecodeOriginPath: mod.bytecodeOriginPath || undefined,
      isEntryPoint: mod.index === result.graph.entryPointId,
    };
    manifest.modules.push(entry);

    if (args.manifestOnly) continue;

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, mod.contents);
    if (args.writeSourcemaps && mod.sourcemap) {
      await writeFile(`${target}.standalone-sourcemap.bin`, mod.sourcemap);
    }
    if (args.writeBytecode && mod.bytecode) {
      await writeFile(`${target}.jsc-bytecode.bin`, mod.bytecode);
    }
    if (args.writeModuleInfo && mod.moduleInfo) {
      await writeFile(`${target}.module-info.bin`, mod.moduleInfo);
    }
  }

  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Extracted ${result.modules.length} module(s) from ${path.basename(executable)}`);
  console.log(`Output: ${outDir}`);
  if (result.graph.hasBytecode) {
    console.log("Bytecode blobs were present; bundled source was still extracted when embedded.");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
