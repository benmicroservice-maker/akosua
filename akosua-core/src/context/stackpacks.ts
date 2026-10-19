import type { StackFingerprint } from "./fingerprint.js";

/** Stack packs (A6): Akosua's asymmetry vs generalist IDEs. A pack turns a
 * detected stack into (1) hard rules the agent must follow, (2) a failure
 * playbook, and (3) research routing bias. Injected into the system prompt
 * and surfaced in the Project Brain — version-pinned docs stay Context7-first
 * per the product philosophy; packs tell the agent WHAT to look up. */

export interface StackPack {
  id: string;
  label: string;
  active: boolean;
  rules: string[];
  playbook: string[];
  research: string[];
}

export function detectStackPacks(fp: StackFingerprint): StackPack[] {
  const packs: StackPack[] = [];
  const transports = fp.backend?.transports ?? [];
  if (fp.backend?.framework === "nestjs") packs.push({
    id: "nestjs-microservices", label: "NestJS Microservices", active: true,
    rules: [
      `Adapter in use: ${fp.backend.adapter ?? "unknown"} — do not mix Fastify/Express APIs; prove the adapter from package.json before using platform-specific calls.`,
      "Respect module boundaries: providers are not imported across services except via the transport or shared contracts package.",
      "DTOs are the contract: validate at the boundary (class-validator), and when a DTO changes, find every consumer before editing.",
      ...(transports.length ? [`Transports detected: ${transports.join(", ")}. Message handlers must be idempotent; check ack/nack + retry semantics in the version-pinned docs before touching handlers.`] : []),
      ...(fp.backend.orm ? [`ORM: ${fp.backend.orm}. Schema/migration changes require the matching client regeneration step in Verify.`] : []),
    ],
    playbook: [
      "Message silently dropped → check ack mode, dead-letter/retry config, and payload shape vs the DTO first.",
      "Works locally, fails in service → check transport serialisation (plain JSON only across the wire) and env/config module loading order.",
    ],
    research: ["Context7: NestJS + transport library docs at the version in the lockfile, before any handler/DTO change."],
  });
  if (fp.web?.framework === "nextjs") packs.push({
    id: "nextjs", label: "Next.js Web", active: true,
    rules: [
      "Know which router you are in (app vs pages) from the file tree before writing routes; never mix conventions.",
      "Server vs client boundary: no client hooks in Server Components; 'use client' is a deliberate, minimal leaf decision.",
      "Data fetching belongs in Server Components/route handlers; client state is for interaction only.",
    ],
    playbook: ["Hydration mismatch → look for server/client render divergence (dates, random, window) before touching data code."],
    research: ["Context7: Next.js docs for the exact installed version (breaking changes between majors are common)."],
  });
  if (fp.mobile?.framework === "flutter") packs.push({
    id: "flutter-riverpod", label: "Flutter + Riverpod", active: true,
    rules: [
      "Riverpod: providers are the architecture. UI watches providers; providers never import widgets. Use the project's generation style (codegen vs manual) — prove it from existing providers.",
      "No setState for shared/business state. Async state renders all three states (data/loading/error).",
      "Keep widgets dumb: extract when a build method mixes layout with logic.",
    ],
    playbook: ["Provider not updating → check provider type/autoDispose and whether the widget watches vs reads before rewriting logic."],
    research: ["Context7/pub.dev: exact riverpod + generator versions from pubspec.lock before adding provider APIs."],
  });
  if (fp.backend?.orm) packs.push({
    id: "data-orm", label: `Data (${fp.backend.orm})`, active: true,
    rules: [
      "Entity/model ↔ DTO ↔ API drift is a defect class: when one changes, check the other two explicitly.",
      "Migrations are append-only history; never edit an applied migration.",
    ],
    playbook: ["Type errors after schema change → regenerate the client before hunting code bugs."],
    research: ["Context7: ORM docs at lockfile version for query/relation APIs."],
  });
  if (fp.python) packs.push({
    id: "python-automation", label: "Python Automations", active: true,
    rules: [
      "Match the project's runner (venv/poetry/uv) — prove it from pyproject/lockfiles; never pip-install into a random interpreter.",
      "Automations fail loudly: no bare except-pass around external calls; log + non-zero exit on failure.",
    ],
    playbook: ["Works interactively, fails scheduled → environment/PATH/interpreter mismatch first, code second."],
    research: ["PyPI + official docs for exact dependency versions."],
  });
  return packs;
}

export function renderStackPacks(fp: StackFingerprint): string {
  const packs = detectStackPacks(fp);
  if (!packs.length) return "";
  const body = packs.map(p => [
    `## Stack pack: ${p.label}`,
    "Rules (standing, stack-specific — they outrank generic habits):",
    ...p.rules.map(r => `- ${r}`),
    "Failure playbook (check in this order):",
    ...p.playbook.map(r => `- ${r}`),
    "Research routing:",
    ...p.research.map(r => `- ${r}`),
  ].join("\n")).join("\n\n");
  return `\n\n# ACTIVE STACK PACKS (detected from this project's manifests — follow them)\n${body}`;
}
