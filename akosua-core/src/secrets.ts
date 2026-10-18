/** Secret storage abstraction. In Akosua desktop this is backed by VS Code
 * SecretStorage (-> Windows Credential Manager). Keys are NEVER written to
 * project files or logs. These dev implementations exist for tests/CLI use. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const SecretKeys = {
  anthropic: "akosua.provider.anthropic",
  openai: "akosua.provider.openai",
  firecrawl: "akosua.research.firecrawl",
  context7: "akosua.research.context7",
  transcriptApi: "akosua.research.transcriptApi",
  github: "akosua.github.token",
} as const;

export class InMemorySecretStore implements SecretStore {
  private m = new Map<string, string>();
  async get(k: string) { return this.m.get(k); }
  async set(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}

/** Dev-only: reads AKOSUA_* environment variables. Never used to persist. */
export class EnvSecretStore implements SecretStore {
  async get(k: string) {
    const envName = "AKOSUA_" + k.replace(/^akosua\./, "").replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
    return process.env[envName];
  }
  async set() { throw new Error("EnvSecretStore is read-only"); }
  async delete() { throw new Error("EnvSecretStore is read-only"); }
}
