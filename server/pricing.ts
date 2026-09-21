/**
 * Cost estimate inputs. runo does not read the AWS bill (that needs Cost
 * Explorer permissions and lags ~24h): it multiplies what it observed — hours
 * running, GB provisioned — by this table. Admins edit it in the panel; the
 * defaults are public on-demand Linux prices and WILL drift.
 *
 * Not modeled: data transfer, snapshot/AMI storage of `runo bake`, and the
 * surplus CPU credits of `unlimited` burstables under sustained load.
 */
import { RunoError } from "../src/errors";

export interface Pricing {
  /** USD per running hour, on-demand, by instance type. */
  instance_hourly: Record<string, number>;
  /** Multiplier applied to instance_hourly for spot machines (1 = priced as on-demand, a ceiling). */
  spot_factor: number;
  /** USD per GB-month of gp3, charged while the machine exists (stopped included). */
  ebs_gb_month: number;
  /** USD per volume-month for the IOPS/throughput runo provisions above the gp3 baseline (4000/300). */
  ebs_extra_month: number;
  /** USD per hour of public IPv4, charged while running. */
  ipv4_hourly: number;
}

const US_EAST: Record<string, number> = {
  "t3.micro": 0.0104, "t3.small": 0.0208, "t3.medium": 0.0416, "t3.large": 0.0832,
  "t3.xlarge": 0.1664, "t3.2xlarge": 0.3328,
  "t3a.micro": 0.0094, "t3a.small": 0.0188, "t3a.medium": 0.0376, "t3a.large": 0.0752,
  "t3a.xlarge": 0.1504, "t3a.2xlarge": 0.3008,
  "m7i-flex.large": 0.09576, "m7i-flex.xlarge": 0.19152, "m7i-flex.2xlarge": 0.38304,
  "m7i.large": 0.1008, "m7i.xlarge": 0.2016, "m7i.2xlarge": 0.4032,
  "m6i.large": 0.096, "m6i.xlarge": 0.192, "m6i.2xlarge": 0.384,
  "c7i.large": 0.08925, "c7i.xlarge": 0.1785, "c7i.2xlarge": 0.357,
};

const BY_REGION: Record<string, Record<string, number>> = {
  "us-east-1": US_EAST,
  "us-east-2": US_EAST,
  "sa-east-1": {
    "t3.micro": 0.0168, "t3.small": 0.0336, "t3.medium": 0.0672, "t3.large": 0.1344,
    "t3.xlarge": 0.2688, "t3.2xlarge": 0.5376,
  },
};

export function defaultPricing(region: string): Pricing {
  return {
    instance_hourly: { ...(BY_REGION[region] ?? {}) },
    spot_factor: 1,
    ebs_gb_month: region === "sa-east-1" ? 0.152 : 0.08,
    // (4000 - 3000) IOPS x $0.005 + (300 - 125) MB/s x $0.04
    ebs_extra_month: 12,
    ipv4_hourly: 0.005,
  };
}

const num = (v: unknown, field: string, max: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max)
    throw new RunoError(`pricing.${field} must be a number between 0 and ${max}`);
  return v;
};

/** Validates a full pricing document coming from the panel. */
export function parsePricing(input: any): Pricing {
  if (!input || typeof input !== "object") throw new RunoError("pricing must be an object");
  const hourly: Record<string, number> = {};
  for (const [type, price] of Object.entries(input.instance_hourly ?? {})) {
    if (!/^[a-z0-9-]+\.[a-z0-9]+$/.test(type)) throw new RunoError(`"${type}" is not an instance type`);
    hourly[type] = num(price, `instance_hourly["${type}"]`, 1000);
  }
  return {
    instance_hourly: hourly,
    spot_factor: num(input.spot_factor, "spot_factor", 1),
    ebs_gb_month: num(input.ebs_gb_month, "ebs_gb_month", 10),
    ebs_extra_month: num(input.ebs_extra_month, "ebs_extra_month", 1000),
    ipv4_hourly: num(input.ipv4_hourly, "ipv4_hourly", 10),
  };
}
