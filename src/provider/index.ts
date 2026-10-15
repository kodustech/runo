import { RunoError } from "../errors";
import { Ec2Provider } from "./aws";
import { GceProvider } from "./gce";
import { RemoteProvider } from "./remote";
import type { RuntimeProvider } from "./types";

const providers: Record<string, () => RuntimeProvider> = {
  aws: () => new Ec2Provider(),
  gce: () => new GceProvider(),
};

/** Which cloud direct mode (and the control plane) creates VMs in: RUNO_PROVIDER, default aws. */
export function defaultProviderName(): string {
  return process.env.RUNO_PROVIDER?.trim() || "aws";
}

let cached: RuntimeProvider | undefined;

export function getProvider(name = defaultProviderName()): RuntimeProvider {
  // Control-plane mode: RUNO_SERVER set → every provider operation goes to
  // runo-server (which holds the AWS credentials); the laptop needs none.
  const server = process.env.RUNO_SERVER;
  if (server) {
    if (cached?.name === "remote") return cached;
    const token = process.env.RUNO_TOKEN;
    if (!token)
      throw new RunoError(
        "RUNO_SERVER is set but RUNO_TOKEN is missing",
        "Ask the runo-server operator for your token and export RUNO_TOKEN",
      );
    cached = new RemoteProvider(server, token);
    return cached;
  }
  if (cached?.name === name) return cached;
  const factory = providers[name];
  if (!factory)
    throw new RunoError(
      `Unknown provider "${name}"`,
      `Available providers: ${Object.keys(providers).join(", ")}`,
    );
  cached = factory();
  return cached;
}
