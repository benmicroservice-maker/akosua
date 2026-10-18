# Akosua (built-in extension, v0.1.0)
Ships inside the Akosua Code-OSS fork as a built-in extension (Activity Bar → Akosua).
- **Chat view** (webview): Providers & Keys tab + Chat tab.
- **Providers & Keys**: Claude/OpenAI/Firecrawl/Context7/TranscriptAPI keys stored ONLY via
  VS Code SecretStorage (Windows Credential Manager), with Save / Test connection / Clear,
  plus Command Palette equivalents (`Akosua: Set … API Key`, `Akosua: Clear All API Keys`).
- **Settings** (`akosua.*`): planner/editor/reviewer provider routing (default Claude/Claude/OpenAI)
  and explicit model ids — blank models are never guessed.
- **Chat (v1)**: single-shot call through @akosua/core providers. The phase-gated agent
  (Understand→Research→Plan→Build→Verify) wiring into this panel is the next integration step.
Build: `npm run compile` (builds @akosua/core first). Pure config logic tested in `test/`.
Install into a full Code-OSS clone: `../scripts/install-into-codeoss.ps1 -VsCodePath <clone>`.
