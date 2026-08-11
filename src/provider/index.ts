import { RunoError } from "../errors";
import { Ec2Provider } from "./aws";
import type { RuntimeProvider } from "./types";

const providers: Record<string, () => RuntimeProvider> = {
  aws: () => new Ec2Provider(),
};

let cached: RuntimeProvider | undefined;

export function getProvider(name = "aws"): RuntimeProvider {
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
