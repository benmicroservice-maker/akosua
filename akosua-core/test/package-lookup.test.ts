import test from "node:test";
import assert from "node:assert/strict";
import { PackageLookupClient } from "../src/research/clients.js";

const jsonRes = (obj: unknown, status = 200) => ({
  ok: status < 400, status, text: async () => JSON.stringify(obj),
  json: async () => obj, body: null,
});

test("package_lookup npm: latest version, repo, candidate changelog, cache", async () => {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    return jsonRes({
      "dist-tags": { latest: "11.1.0" },
      time: { created: "2018-01-01", modified: "2026-01-01", "11.1.0": "2026-09-01T00:00:00Z", "11.0.0": "2026-08-01T00:00:00Z" },
      versions: { "11.1.0": { description: "Nest Fastify adapter", homepage: "https://nestjs.com", repository: { url: "git+https://github.com/nestjs/nest.git" } } },
    });
  };
  const c = new PackageLookupClient(undefined, fetchFn as never);
  const out = await c.lookup("@nestjs/platform-fastify", "npm");
  assert.match(out, /Latest: 11\.1\.0 \(published 2026-09-01\)/);
  assert.match(out, /Repository: https:\/\/github\.com\/nestjs\/nest\n/);
  assert.match(out, /Changelog \(CANDIDATE, unverified\)/);
  assert.match(out, /lockfile/);
  await c.lookup("@nestjs/platform-fastify", "npm");
  assert.equal(calls.length, 1, "second lookup must be served from cache");
});

test("package_lookup pub + pypi shapes, auto fallback, honest not-found", async () => {
  const fetchFn = async (url: string) => {
    if (url.includes("not-a-real")) return jsonRes({}, 404);
    if (url.includes("pub.dev")) return jsonRes({ latest: { version: "2.6.5", pubspec: { description: "Riverpod state management", homepage: "https://riverpod.dev", repository: "https://github.com/rrousselGit/riverpod" } } });
    if (url.includes("pypi.org")) return jsonRes({ info: { version: "0.115.0", summary: "FastAPI framework", project_urls: { Documentation: "https://fastapi.tiangolo.com", Source: "https://github.com/fastapi/fastapi" }, requires_python: ">=3.8" } });
    return jsonRes({}, 404);
  };
  const c = new PackageLookupClient(undefined, fetchFn as never);
  assert.match(await c.lookup("flutter_riverpod", "pub"), /pub\.dev registry[\s\S]*Latest: 2\.6\.5/);
  assert.match(await c.lookup("fastapi", "pypi"), /PyPI registry[\s\S]*Latest: 0\.115\.0/);
  const missing = await c.lookup("definitely-not-a-real-package-xyz", "auto");
  assert.match(missing, /No package "definitely-not-a-real-package-xyz" found/);
  assert.match(missing, /do not guess a substitute/);
});
