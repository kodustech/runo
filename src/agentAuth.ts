import { existsSync, readFileSync } from "node:fs";
import { AGENT_ENV_PATH } from "./config";
import { RunoError } from "./errors";

const KNOWN_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * Resolve as chaves dos agentes (decisão 10):
 *  1. env vars do processo;
 *  2. ~/.kodus/agent.env (global, independente do RUNO_HOME; formato KEY=valor).
 * NUNCA logar/imprimir os valores retornados.
 */
export function resolveAgentEnv(): Record<string, string> {
  const fromFile: Record<string, string> = {};
  if (existsSync(AGENT_ENV_PATH)) {
    for (const line of readFileSync(AGENT_ENV_PATH, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      fromFile[key] = val;
    }
  }
  const out: Record<string, string> = {};
  for (const key of KNOWN_KEYS) {
    const v = process.env[key] ?? fromFile[key];
    if (v) out[key] = v;
  }
  return out;
}

export function requireAgentEnv(agent: "claude" | "codex"): Record<string, string> {
  const env = resolveAgentEnv();
  if (agent === "claude") {
    // Assinatura primeiro: token headless gerado por `claude setup-token`.
    // Quando presente, vai SOZINHO (uma ANTHROPIC_API_KEY inválida no mesmo
    // ambiente atrapalharia a auth do CLI).
    if (env.CLAUDE_CODE_OAUTH_TOKEN)
      return { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN };
    if (env.ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY };
    throw new RunoError(
      `Nenhuma credencial para o agente "claude"`,
      `Duas opções em ${AGENT_ENV_PATH} (chmod 600) ou no ambiente: (1) assinatura — rode \`claude setup-token\` no laptop e salve a linha CLAUDE_CODE_OAUTH_TOKEN=<token>; (2) API key — ANTHROPIC_API_KEY=<valor>. O login OAuth interativo do laptop não viaja para a VM.`,
    );
  }
  if (!env.OPENAI_API_KEY) {
    throw new RunoError(
      `Chave OPENAI_API_KEY não encontrada para o agente "codex"`,
      `Exporte OPENAI_API_KEY no ambiente OU adicione a linha "OPENAI_API_KEY=<valor>" em ${AGENT_ENV_PATH} (chmod 600). Alternativa: \`codex login\` interativo dentro de \`runo agent codex\`.`,
    );
  }
  return { OPENAI_API_KEY: env.OPENAI_API_KEY };
}
