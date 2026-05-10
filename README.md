# unbun

`unbun` extracts the `StandaloneModuleGraph` embedded by `bun build --compile`
from a standalone executable and writes the bundled modules back to disk.

It recovers what Bun embedded: bundled JavaScript/TypeScript output, assets,
serialized sourcemaps, JavaScriptCore bytecode blobs, and module metadata. If
the app was minified, you get minified bundled code. If the app used bytecode,
the bytecode is saved as a binary blob; it is not decompiled into original
author-written source.

## Usage

```sh
node ./bin/unbun.mjs ./my-compiled-bun-app --out ./my-compiled-bun-app.unpacked
```

Or install/link it as a local CLI:

```sh
npm link
unbun ./my-compiled-bun-app -o ./unpacked
```

The output layout is:

```text
unpacked/
  manifest.json
  files/
    index.js
    ...
```

## How Bun packages executables

Current Bun standalone executables append a serialized module graph to the Bun
runtime. Bun’s source defines this as `StandaloneModuleGraph`.

The graph payload ends with:

```text
[payload bytes][32-byte Offsets struct]["\n---- Bun! ----\n"]
```

The `Offsets` struct points to the module-record list, the entrypoint ID,
embedded runtime argv, and autoload flags. Each module record points to its
virtual path, bundled contents, optional sourcemap, optional bytecode, optional
ESM bytecode module-info, and bytecode origin path.

Platform containers differ:

- macOS: Bun stores the graph in a `__BUN` Mach-O segment.
- Windows: Bun stores it in a `.bun` PE section.
- Linux/FreeBSD: Bun stores it in an ELF `.bun` section/loadable payload.

`unbun` scans for the trailer and then parses the graph by its own offsets,
which lets it work across these containers without rewriting each executable
format first.
