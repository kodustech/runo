import type { ExposeContext, ExposeProvider } from "./types";

/**
 * v1 behavior, kept as the default for existing recipes: open the ports on the
 * security group and address the VM by its public IP. No TLS, no auth, and the
 * URL changes on every suspend/resume (the IP does).
 */
export const ipExpose: ExposeProvider = {
  name: "ip",

  async up(ctx: ExposeContext): Promise<Record<string, string>> {
    await ctx.provider.ensurePorts(ctx.services.map((s) => s.port));
    const urls: Record<string, string> = {};
    if (!ctx.rt.ip) return urls;
    for (const s of ctx.services) urls[s.name] = `http://${ctx.rt.ip}:${s.port}`;
    return urls;
  },

  async down(): Promise<void> {
    // The security group is shared by every env of this install — closing
    // ports here would break the other envs. `runo destroy --all` removes it.
  },
};
