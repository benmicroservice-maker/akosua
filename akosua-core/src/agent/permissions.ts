/**
 * Permission tiers (agent-UI research pattern): most commands run freely —
 * friction where it matters. Destructive/irreversible commands require an
 * explicit human confirmation through the host UI; with no host hook the
 * default is DENY (the user can run it themselves in a terminal). The model
 * is told exactly what happened so it adapts instead of retrying blindly.
 */
const DESTRUCTIVE: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, why: "recursive force delete" },
  { re: /\bdel\s+\/[sq]/i, why: "recursive delete (Windows)" },
  { re: /Remove-Item\b[^|;]*-Recurse[^|;]*-Force|Remove-Item\b[^|;]*-Force[^|;]*-Recurse/i, why: "recursive force delete (PowerShell)" },
  { re: /\bgit\s+push\b/i, why: "pushes to a remote" },
  { re: /\bgit\s+reset\s+--hard\b/i, why: "discards uncommitted work" },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, why: "deletes untracked files" },
  { re: /\bgit\s+checkout\s+--\s|\bgit\s+restore\s/i, why: "discards file changes" },
  { re: /\b(drop\s+database|drop\s+table|truncate\s+table)\b/i, why: "drops database objects" },
  { re: /\bmkfs\b|\bformat\s+[a-z]:/i, why: "formats a disk" },
  { re: /\b(shutdown|reboot)\b/i, why: "shuts down the machine" },
  { re: />\s*\/(etc|usr|bin|boot)\//i, why: "overwrites a system path" },
];

export function classifyCommand(command: string): { tier: "standard" } | { tier: "destructive"; why: string } {
  for (const d of DESTRUCTIVE) if (d.re.test(command)) return { tier: "destructive", why: d.why };
  return { tier: "standard" };
}
