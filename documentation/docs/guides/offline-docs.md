---
title: Offline / Air-gapped Docs
sidebar_position: 95
sidebar_label: Offline Docs
---

# Offline / Air-gapped Docs

The `aegis-doc-guide` skill reads official aegis documentation before answering
aegis-specific questions. By default it reads from `https://goose-docs.ai`. In
an offline or air-gapped environment, point aegis at a **local copy** instead by
setting `AEGIS_DOCS_ROOT`.

- If `AEGIS_DOCS_ROOT` is set (in `config.yaml` or the environment), aegis uses
  it as the docs root — either a local filesystem path or an HTTP(S) URL.
- If it is not set, aegis falls back to `https://goose-docs.ai`.

When the root is a local path, aegis reads the docs with its file tools; no
network access is required.

## Docs layout

A docs root contains a docs map and a `docs/` tree:

```
<docs-root>/
├── aegis-docs-map.md
└── docs/
    ├── getting-started/...
    └── guides/...
```

`aegis-docs-map.md` is the index the skill searches first; every page it reads
is referenced by a path listed there.

## Building a local docs root

Build the docs from a aegis checkout using the same version as your aegis
binary, so the docs match the runtime. The standard documentation build already
produces everything aegis needs — a `aegis-docs-map.md` index and a `docs/` tree
of markdown files — so no custom tooling is required:

```bash
git checkout v1.41.0   # match your aegis binary version
cd documentation
npm run build
```

This writes the docs root to `documentation/build/`, containing:

```
build/
├── aegis-docs-map.md
└── docs/
    ├── getting-started/...
    └── guides/...
```

`npm run build` requires registry access, so run it in an online environment.
Then copy the resulting `build/` directory to your air-gapped target location
(for example `/opt/aegis-docs`) and point `AEGIS_DOCS_ROOT` at it.

## Configuring aegis

Set `AEGIS_DOCS_ROOT` in `config.yaml`:

```yaml
AEGIS_DOCS_ROOT: "/opt/aegis-docs"
```

Or via the environment:

```bash
export AEGIS_DOCS_ROOT=/opt/aegis-docs
```

For a managed distribution, bake the docs tree into your image and set
`AEGIS_DOCS_ROOT` in the shipped `config.yaml` or launcher environment.

## Notes

- Documentation links in aegis's answers always render as canonical
  `https://goose-docs.ai/...` URLs, even when read locally.
- A custom HTTP(S) mirror also works: set `AEGIS_DOCS_ROOT` to its root URL.
- For MCP extension runtime issues offline, see
  [Airgapped/Offline Environment Issues](/docs/troubleshooting/known-issues#airgappedoffline-environment-issues).
