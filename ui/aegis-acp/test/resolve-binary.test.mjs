import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { isAbsolute, join, relative, resolve } from "node:path";

import * as publicApi from "../dist/index.js";
import { resolveAegisBinaryForRuntime } from "../dist/resolve-binary.js";

const supportedPlatforms = [
  ["darwin", "arm64", "@aaif/goose-binary-darwin-arm64", "aegis"],
  ["darwin", "x64", "@aaif/goose-binary-darwin-x64", "aegis"],
  ["linux", "arm64", "@aaif/goose-binary-linux-arm64", "aegis"],
  ["linux", "x64", "@aaif/goose-binary-linux-x64", "aegis"],
  ["win32", "x64", "@aaif/goose-binary-win32-x64", "aegis.exe"],
];

function setAegisBinary(t, value) {
  const original = process.env.AEGIS_BINARY;
  process.env.AEGIS_BINARY = value;
  t.after(() => {
    if (original === undefined) {
      delete process.env.AEGIS_BINARY;
    } else {
      process.env.AEGIS_BINARY = original;
    }
  });
}

for (const [
  platform,
  arch,
  packageName,
  executableName,
] of supportedPlatforms) {
  test(`resolves ${platform}-${arch}`, () => {
    let resolvedSpecifier;
    let checkedPath;
    const fixturePackageRoot = join("/fixtures", packageName);

    const result = resolveAegisBinaryForRuntime(platform, arch, {
      resolvePackageJson(specifier) {
        resolvedSpecifier = specifier;
        return join(fixturePackageRoot, "package.json");
      },
      isFile(path) {
        checkedPath = path;
        return true;
      },
    });

    assert.equal(resolvedSpecifier, `${packageName}/package.json`);
    assert.equal(result, resolve(fixturePackageRoot, "bin", executableName));
    assert.equal(checkedPath, result);
    assert.equal(isAbsolute(result), true);
  });
}

test("exports only the public resolver from the package root", () => {
  assert.deepEqual(Object.keys(publicApi), ["resolveAegisBinary"]);
});

test("uses AEGIS_BINARY as an explicit override", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "aegis-acp-override-"));
  const binaryPath = join(directory, "aegis");
  writeFileSync(binaryPath, "");
  setAegisBinary(t, relative(process.cwd(), binaryPath));

  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  assert.equal(publicApi.resolveAegisBinary(), binaryPath);
});

test("rejects an invalid AEGIS_BINARY override", (t) => {
  setAegisBinary(t, "missing-aegis-binary");

  assert.throws(
    () => publicApi.resolveAegisBinary(),
    /AEGIS_BINARY does not point to a file/,
  );
});

test("reports unsupported platform and architecture combinations", () => {
  assert.throws(
    () =>
      resolveAegisBinaryForRuntime("freebsd", "x64", {
        resolvePackageJson() {
          throw new Error("should not resolve a package");
        },
        isFile() {
          return false;
        },
      }),
    /No Aegis npm binary is available for freebsd-x64/,
  );
});

test("reports a missing optional platform package", () => {
  assert.throws(
    () =>
      resolveAegisBinaryForRuntime("linux", "x64", {
        resolvePackageJson() {
          throw new Error("module not found");
        },
        isFile() {
          return false;
        },
      }),
    /Aegis binary package @aaif\/aegis-binary-linux-x64 is not installed/,
  );
});

test("reports a missing executable in an installed platform package", () => {
  assert.throws(
    () =>
      resolveAegisBinaryForRuntime("darwin", "arm64", {
        resolvePackageJson() {
          return join(
            "/fixtures",
            "@aaif/goose-binary-darwin-arm64/package.json",
          );
        },
        isFile() {
          return false;
        },
      }),
    /Aegis executable from @aaif\/aegis-binary-darwin-arm64 was not found/,
  );
});
