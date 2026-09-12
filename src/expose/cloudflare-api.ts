import { RunoError } from "../errors";

/**
 * Minimal Cloudflare API client — only what named tunnels need.
 *
 * Everything is driven by one token so an adopting team has a single secret to
 * create and rotate. The token needs:
 *   Account → Cloudflare Tunnel → Edit   (create/delete tunnels, read run token)
 *   Zone    → DNS → Edit                 (the CNAME that points at the tunnel)
 */
const API = "https://api.cloudflare.com/client/v4";

export const TOKEN_ENV = "CLOUDFLARE_API_TOKEN";

interface CfResponse<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

export class CloudflareApi {
  constructor(private token: string) {}

  static fromEnv(): CloudflareApi {
    const token = process.env[TOKEN_ENV]?.trim();
    if (!token)
      throw new RunoError(
        `expose.domain needs a Cloudflare API token in ${TOKEN_ENV}`,
        "Create one at Cloudflare → My Profile → API Tokens with:\n" +
          "  Account → Cloudflare Tunnel → Edit\n" +
          "  Zone → DNS → Edit (on the zone that owns expose.domain)\n" +
          "Without it, drop expose.domain to fall back to zero-setup quick tunnels.",
      );
    return new CloudflareApi(token);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e: any) {
      throw new RunoError(`Cloudflare API unreachable (${method} ${path}): ${e?.message ?? e}`);
    }
    let data: CfResponse<T>;
    try {
      data = (await res.json()) as CfResponse<T>;
    } catch {
      throw new RunoError(`Cloudflare API returned a non-JSON body (${res.status} ${method} ${path})`);
    }
    if (!res.ok || !data.success) {
      const detail = (data.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
      throw new RunoError(
        `Cloudflare API error (${method} ${path}): ${detail || res.status}`,
        res.status === 403
          ? `The ${TOKEN_ENV} token is missing a permission — Cloudflare Tunnel:Edit (account) and DNS:Edit (zone) are both required`
          : undefined,
      );
    }
    return data.result;
  }

  /** The single account the token can see (or the one matching CLOUDFLARE_ACCOUNT_ID). */
  async accountId(): Promise<string> {
    const pinned = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (pinned) return pinned;
    const accounts = await this.call<{ id: string; name: string }[]>("GET", "/accounts?per_page=50");
    if (accounts.length === 0)
      throw new RunoError(`The ${TOKEN_ENV} token can see no Cloudflare account`);
    if (accounts.length > 1)
      throw new RunoError(
        `The ${TOKEN_ENV} token can see ${accounts.length} accounts`,
        `Pin one with CLOUDFLARE_ACCOUNT_ID (${accounts.map((a) => `${a.name}=${a.id}`).join(", ")})`,
      );
    return accounts[0]!.id;
  }

  /**
   * Zone that owns a hostname. "preview.kodus.io" is usually not a zone —
   * walk up the labels until one matches ("kodus.io").
   */
  async zoneIdFor(domain: string): Promise<{ id: string; name: string }> {
    const labels = domain.split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join(".");
      const zones = await this.call<{ id: string; name: string }[]>(
        "GET",
        `/zones?name=${encodeURIComponent(candidate)}`,
      );
      if (zones.length > 0) return { id: zones[0]!.id, name: zones[0]!.name };
    }
    throw new RunoError(
      `No Cloudflare zone found for "${domain}"`,
      `The ${TOKEN_ENV} token must have DNS:Edit on the zone that owns it`,
    );
  }

  /** Creates the env's tunnel, or returns the existing one with the same name. */
  async ensureTunnel(accountId: string, name: string): Promise<{ id: string; token: string }> {
    const existing = await this.call<{ id: string; name: string; deleted_at: string | null }[]>(
      "GET",
      `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
    );
    let id = existing.find((t) => t.name === name && !t.deleted_at)?.id;
    if (!id) {
      const created = await this.call<{ id: string }>("POST", `/accounts/${accountId}/cfd_tunnel`, {
        name,
        // Cloudflare-managed config: ingress rules live in the API, so the VM
        // only ever holds a run token — no credentials file, no config.yml.
        config_src: "cloudflare",
      });
      id = created.id;
    }
    const token = await this.call<string>("GET", `/accounts/${accountId}/cfd_tunnel/${id}/token`);
    return { id, token };
  }

  /** Ingress rules: hostname → local port, plus the mandatory catch-all. */
  async setIngress(
    accountId: string,
    tunnelId: string,
    rules: { hostname: string; port: number }[],
  ): Promise<void> {
    await this.call("PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      config: {
        ingress: [
          ...rules.map((r) => ({
            hostname: r.hostname,
            service: `http://127.0.0.1:${r.port}`,
            originRequest: {
              // dev servers answer on the Host they were asked for; keep it
              noTLSVerify: true,
            },
          })),
          { service: "http_status:404" },
        ],
      },
    });
  }

  async deleteTunnel(accountId: string, name: string): Promise<void> {
    const existing = await this.call<{ id: string; name: string }[]>(
      "GET",
      `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
    );
    for (const t of existing.filter((t) => t.name === name)) {
      // cleanup=true drops lingering connections so the delete does not 400
      await this.call("DELETE", `/accounts/${accountId}/cfd_tunnel/${t.id}?cleanup=true`);
    }
  }

  /** CNAME <hostname> → <tunnelId>.cfargotunnel.com (idempotent). */
  async upsertCname(zoneId: string, hostname: string, tunnelId: string): Promise<void> {
    const target = `${tunnelId}.cfargotunnel.com`;
    const found = await this.call<{ id: string; content: string }[]>(
      "GET",
      `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    );
    const record = { type: "CNAME", name: hostname, content: target, proxied: true, ttl: 1 };
    if (found.length === 0) {
      await this.call("POST", `/zones/${zoneId}/dns_records`, record);
      return;
    }
    if (found[0]!.content !== target)
      await this.call("PUT", `/zones/${zoneId}/dns_records/${found[0]!.id}`, record);
  }

  /** Every record pointing at this tunnel — how `down` finds what it created. */
  async deleteDnsForTunnel(zoneId: string, tunnelId: string): Promise<void> {
    const found = await this.call<{ id: string; content: string }[]>(
      "GET",
      `/zones/${zoneId}/dns_records?type=CNAME&content=${encodeURIComponent(`${tunnelId}.cfargotunnel.com`)}`,
    );
    for (const r of found) await this.call("DELETE", `/zones/${zoneId}/dns_records/${r.id}`);
  }

  /** Tunnel id by name, or null when it does not exist. */
  async findTunnel(accountId: string, name: string): Promise<string | null> {
    const existing = await this.call<{ id: string; name: string }[]>(
      "GET",
      `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
    );
    return existing.find((t) => t.name === name)?.id ?? null;
  }

  async deleteDns(zoneId: string, hostname: string): Promise<void> {
    const found = await this.call<{ id: string }[]>(
      "GET",
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
    );
    for (const r of found) await this.call("DELETE", `/zones/${zoneId}/dns_records/${r.id}`);
  }
}
