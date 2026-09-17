import { RunoError } from "../errors";

/** Optional deployment boundary, checked before serving any control-plane request. */
export function verifyIdentity(arn: string | undefined, region: string, expectedArn?: string, expectedRegion?: string): void {
  if (expectedArn && arn !== expectedArn)
    throw new RunoError(`AWS identity mismatch: expected ${expectedArn}, received ${arn ?? "unknown"}`);
  if (expectedRegion && region !== expectedRegion)
    throw new RunoError(`AWS region mismatch: expected ${expectedRegion}, received ${region}`);
}
