# aegis-sdk

Python bindings for the aegis Development Kit (GDK).

This package is generated from the Rust `aegis-sdk` crate using UniFFI.

## Build a local wheel

From the repository root:

```bash
just --justfile crates/aegis-sdk/justfile python-wheel
```

The wheel is written to `crates/aegis-sdk/python/dist/`.
