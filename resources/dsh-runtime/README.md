# Bundled DSH runtime

`pnpm runtime:sync` imports the complete standalone DSH executable and stores it
as Brotli-compressed release resources. On first launch the desktop app expands
the files into its writable application-data directory and reuses that verified
copy on later launches. A checkout and an installed app therefore work without
Node.js or a separate `deepseek-harness` repository.

The executable is produced by DSH's official standalone builder. It contains
the full DSH runtime, web profile, model adapters, agent loop, cache behavior,
tools, and plugin loader. The desktop process only starts it and speaks DSH's
native Remote API.
