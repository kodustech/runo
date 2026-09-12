/**
 * Expose interface: how an env's services become reachable from outside.
 *
 * Nothing outside src/expose/<impl>.ts knows whether that is a public IP, a
 * tunnel or a proxy — the engine only asks for "service name → URL", the same
 * way it only asks the RuntimeProvider for a VM.
 */
import type { Runtime, RuntimeProvider } from "../provider/types";

export interface ExposeService {
  name: string;
  port: number;
  /** The env's main entry point (runo url prints it first). */
  primary: boolean;
}

export interface ExposeContext {
  provider: RuntimeProvider;
  rt: Runtime;
  envName: string;
  slug: string;
  services: ExposeService[];
}

export interface ExposeProvider {
  readonly name: string;

  /**
   * Makes the services reachable and returns service name → URL.
   * Idempotent: called on every up, resume and reconcile.
   */
  up(ctx: ExposeContext): Promise<Record<string, string>>;

  /** Releases what lives OFF the VM (DNS records, named tunnels). */
  down(ctx: Omit<ExposeContext, "services">): Promise<void>;
}
