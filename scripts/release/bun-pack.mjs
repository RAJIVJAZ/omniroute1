#!/usr/bin/env node
/**
 * bun-pack.mjs — bun-first release pack script
 *
 * Produces a universal npm tarball via `bun pm pack` (or `npm pack` fallback).
 * The tarball installs with both `bun add -g <tarball>` and `npm install -g <tarball>`.
 *
 * Usage:
 *   bun run bun:release                    # build + pack (bun, default)
 *   bun run bun:release -- --pm npm        # npm fallback
 *   node scripts/release/bun-pack.mjs --skip-build --destination .  # reuse staged dist
 */

import { spawnSync } from "node:child_process";
import { resolve, basename } from "node:path";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

function fail(message, code = 1) {
  console.error(`[bun-pack] ${message}`);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  const env = { ...process.env, ...opts.env };
  const result = spawnSync(cmd, args, { ...opts, env, stdio: "inherit", shell: false });
  if (result.status !== 0) {
    fail(`${cmd} ${args.join(" ")} exited with code ${result.status}`);
  }
  return result;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { pm: "bun", skipBuild: false, destination: "_artifacts" };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pm") {
      result.pm = args[++i];
    } else if (arg === "--skip-build") {
      result.skipBuild = true;
    } else if (arg === "--destination") {
      result.destination = args[++i];
    } else if (arg.startsWith("--pm=")) {
      result.pm = arg.split("=")[1];
    } else if (arg.startsWith("--destination=")) {
      result.destination = arg.split("=")[1];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: bun scripts/release/bun-pack.mjs [options]

Options:
  --pm <bun|npm>        Package manager to use for packing (default: bun)
  --skip-build          Skip the build step, reuse existing dist/
  --destination <path>  Output directory for tarball (default: _artifacts)
  --help, -h            Show this help
      `);
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  if (!["bun", "npm"].includes(result.pm)) {
    fail(`--pm must be 'bun' or 'npm', got '${result.pm}'`);
  }

  return result;
}

function verifyTarball(tarballPath) {
  // tarballPath could be a directory or a file
  let tarball;
  if (existsSync(tarballPath)) {
    const stat = require("node:fs").statSync(tarballPath);
    if (stat.isDirectory()) {
      const files = readdirSync(tarballPath).filter((f) => f.endsWith(".tgz"));
      if (files.length === 0) {
        fail("No .tgz file found in destination directory");
      }
      tarball = resolve(tarballPath, files[0]);
    } else {
      tarball = tarballPath;
    }
  } else {
    // Try to find it in the parent directory
    const parentDir = resolve(tarballPath, "..");
    const files = readdirSync(parentDir).filter((f) => f.endsWith(".tgz"));
    if (files.length === 0) {
      fail("No .tgz file found in destination");
    }
    tarball = resolve(parentDir, files[0]);
  }

  console.log(`📦 Verifying tarball: ${tarball}`);

  // Quick verification - check it has required files
  const tmpDir = resolve("/tmp", `bun-pack-verify-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    run("tar", ["xzf", tarball, "-C", tmpDir]);

    const pkgPath = resolve(tmpDir, "package", "package.json");
    if (!existsSync(pkgPath)) {
      fail("Tarball missing package.json");
    }

    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    console.log(`   name: ${pkg.name}`);
    console.log(`   version: ${pkg.version}`);

    // Check for required bin entries - they're in package/bin/
    const requiredBins = ["omniroute", "omniroute-reset-password"];
    for (const bin of requiredBins) {
      const binFileName = bin === "omniroute-reset-password" ? "reset-password.mjs" : `${bin}.mjs`;
      const binPath = resolve(tmpDir, "package", "bin", binFileName);
      console.log(`   Checking: ${binPath}`);
      console.log(`   Exists: ${existsSync(binPath)}`);
      if (!existsSync(binPath)) {
        // List what's in bin directory
        const binDir = resolve(tmpDir, "package", "bin");
        if (existsSync(binDir)) {
          console.log(`   Bin dir contents: ${readdirSync(binDir).join(", ")}`);
        }
        fail(`Tarball missing required bin: ${bin} (file: ${binFileName})`);
      }
      console.log(`   ✓ bin/${binFileName}`);
    }

    // Check dist directory exists
    const distPath = resolve(tmpDir, "package", "dist");
    if (!existsSync(distPath)) {
      fail("Tarball missing dist/ directory");
    }
    console.log(`   ✓ dist/`);

    const entryCount = readdirSync(distPath, { recursive: true }).length;
    console.log(`   ✓ ${entryCount} entries in dist/`);

    console.log("✅ Tarball verification passed");
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  return tarball;
}

async function main() {
  const { pm, skipBuild, destination } = parseArgs();
  const repoRoot = resolve(__dirname, "..", "..");
  const artifactDir = resolve(repoRoot, destination);

  console.log(`[bun-pack] Using package manager: ${pm}`);
  console.log(`[bun-pack] Repo root: ${repoRoot}`);
  console.log(`[bun-pack] Artifact dir: ${artifactDir}`);

  if (!skipBuild) {
    console.log("[bun-pack] Running build:release...");
    run(pm, ["run", "build:release"], { cwd: repoRoot });
  } else {
    console.log("[bun-pack] Skipping build (--skip-build)...");
    const distPath = resolve(repoRoot, "dist");
    if (!existsSync(distPath)) {
      fail("--skip-build but dist/ does not exist");
    }
    console.log(`[bun-pack] Using existing dist/ at ${distPath}`);
  }

  console.log("[bun-pack] Packing tarball...");
  mkdirSync(artifactDir, { recursive: true });

  if (pm === "bun") {
    run("bun", ["pm", "pack", "--destination", artifactDir], { cwd: repoRoot });
  } else {
    run("npm", ["pack", "--pack-destination", artifactDir], { cwd: repoRoot });
  }

  const tarball = verifyTarball(artifactDir);
  console.log(`\n✅ Done! Tarball: ${tarball}`);
  console.log(`   Install with: bun add -g ${tarball}  OR  npm install -g ${tarball}`);
}

main().catch((err) => {
  console.error("[bun-pack] Fatal error:", err);
  process.exit(1);
});
