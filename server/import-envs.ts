/** Operator-only migration. Run on the server with the same RUNO_HOME as the old CI fleet. */
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AWS_REGION, HASH6, RUNO_HOME } from "../src/config";

const owner = process.argv[2];
const repo = process.argv[3];
const recipe = process.argv[4];
if (!owner || !repo || !recipe) throw new Error("Usage: bun server/import-envs.ts <owner> <repo> <recipe>");
const file = path.join(RUNO_HOME, "server-envs.json");
const envs = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const ec2 = new EC2Client({ region: AWS_REGION });
let next: string | undefined;
do {
  const page = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: "tag:runo:home-hash", Values: [HASH6] },
      { Name: "tag:runo:repo", Values: [repo] },
      { Name: "tag:runo:managed", Values: ["true"] },
      { Name: "instance-state-name", Values: ["running", "stopped", "pending", "stopping"] },
    ], NextToken: next,
  }));
  for (const reservation of page.Reservations ?? []) for (const vm of reservation.Instances ?? []) {
    const tags = Object.fromEntries((vm.Tags ?? []).map(t => [t.Key, t.Value]));
    const name = tags.Name;
    if (!name || !tags["runo:branch"] || !vm.InstanceId) throw new Error("Incomplete instance tags");
    if (envs[name]) {
      if (envs[name].instanceId !== vm.InstanceId) throw new Error(`Conflicting instance for ${name}`);
      continue;
    }
    envs[name] = {
      envName: name, slug: tags["runo:env"], repo, branch: tags["runo:branch"],
      owner, members: [], instanceId: vm.InstanceId, instanceType: vm.InstanceType,
      spot: vm.InstanceLifecycle === "spot", recipe, createdAt: vm.LaunchTime?.toISOString(),
    };
    console.log(`Imported ${name} (${vm.InstanceId})`);
  }
  next = page.NextToken;
} while (next);
mkdirSync(RUNO_HOME, { recursive: true });
writeFileSync(`${file}.tmp`, JSON.stringify(envs, null, 2) + "\n", { mode: 0o600 });
renameSync(`${file}.tmp`, file);
