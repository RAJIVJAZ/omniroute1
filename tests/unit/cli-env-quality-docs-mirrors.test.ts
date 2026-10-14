import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const envDoc = "docs/reference/ENVIRONMENT.md";
const qualityDoc = "docs/routing/AUTO-COMBO.md";
const names = [
  "OMNIROUTE_NO_UPDATE_NOTIFIER",
  "OMNIROUTE_DOCTOR_LIVENESS_URL",
  "OMNIROUTE_PROVIDER_CATALOG_PATH",
  "OMNIROUTE_PROVIDER_TEST_MODEL",
];
const qualityPath = "open-sse/services/routing/quality.ts";
interface State {
  sources: Record<
    string,
    { source_hash: string; locales: Record<string, { source_hash: string; target_hash: string }> }
  >;
}
const state: State = JSON.parse(read(".i18n-state.json"));
const config: { locales: { code: string }[]; docsExcluded?: string[] } = JSON.parse(
  read("config/i18n.json")
);
const locales = config.locales
  .map((locale) => locale.code)
  .filter((locale) => !(config.docsExcluded ?? ["en"]).includes(locale));

test("published English sources contain the four CLI variables and cold quality-start note", () => {
  for (const name of names) assert(read(envDoc).includes(name));
  assert(read(qualityDoc).includes(qualityPath));
});

test("every documentation locale covers the newly published CLI and cold-start contracts", () => {
  const missing: string[] = [];
  for (const locale of locales) {
    const env = read(`docs/i18n/${locale}/${envDoc}`);
    for (const name of names) if (!env.includes(name)) missing.push(`${locale}: ${name}`);
    const quality = read(`docs/i18n/${locale}/${qualityDoc}`);
    if (!quality.includes(qualityPath)) missing.push(`${locale}: quality tracker`);
  }
  assert.equal(missing.length, 0, missing.slice(0, 8).join(", "));
});

test("the two source-delta mirror records describe current source and translated bytes", () => {
  for (const relative of [envDoc, qualityDoc]) {
    const sourceHash = hash(read(relative));
    assert.equal(state.sources[relative].source_hash, sourceHash);
    for (const locale of locales) {
      const record = state.sources[relative].locales[locale];
      assert.equal(record.source_hash, sourceHash);
      assert.equal(record.target_hash, hash(read(`docs/i18n/${locale}/${relative}`)));
    }
  }
});
