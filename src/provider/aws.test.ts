import { expect, test } from "bun:test";
import { DescribeInstancesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { Ec2Provider } from "./aws";

function notFound() {
  const e: any = new Error("The instance ID 'i-new' does not exist");
  e.name = "InvalidInstanceID.NotFound";
  return e;
}

function providerWith(send: (cmd: any) => Promise<any>): Ec2Provider {
  const p = new Ec2Provider();
  (p as any).ec2 = { send };
  (p as any).pollMs = 1;
  return p;
}

test("a just-launched instance may answer NotFound for a while before it is running", async () => {
  let describes = 0;
  const p = providerWith(async (cmd) => {
    if (cmd instanceof DescribeInstancesCommand) {
      if (++describes <= 3) throw notFound();
      return { Reservations: [{ Instances: [{ InstanceId: "i-new", State: { Name: "running" }, PublicIpAddress: "203.0.113.9" }] }] };
    }
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  const rt = await (p as any).waitForState("i-new", "running", 10_000, true);
  expect(rt).toMatchObject({ id: "i-new", state: "running", ip: "203.0.113.9" });
  expect(describes).toBe(4);
});

test("an instance seen once and then gone is a real termination", async () => {
  let describes = 0;
  const p = providerWith(async (cmd) => {
    if (cmd instanceof DescribeInstancesCommand) {
      if (++describes === 1) return { Reservations: [{ Instances: [{ InstanceId: "i-x", State: { Name: "pending" } }] }] };
      throw notFound();
    }
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  await expect((p as any).waitForState("i-x", "running", 10_000, true)).rejects.toThrow(/terminated unexpectedly/);
});

test("status still reports a vanished instance as terminated", async () => {
  const p = providerWith(async () => { throw notFound(); });
  expect((await p.status({ id: "i-gone", ip: null, state: "unknown" })).state).toBe("terminated");
});

test("create terminates the instance it launched when it never comes up", async () => {
  const terminated: string[] = [];
  const p = providerWith(async (cmd) => {
    if (cmd instanceof DescribeInstancesCommand)
      return { Reservations: [{ Instances: [{ InstanceId: "i-dead", State: { Name: "shutting-down" } }] }] };
    if (cmd instanceof TerminateInstancesCommand) { terminated.push(...cmd.input.InstanceIds!); return {}; }
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  (p as any).ensureKeyPair = async () => {};
  (p as any).ensureSecurityGroup = async () => "sg-1";
  (p as any).claimFromPool = async () => null;
  (p as any).launchInstance = async () => "i-dead";
  await expect(
    p.create({ envName: "e", slug: "e", instanceType: "t3.medium", diskGb: 20, repo: "app", branch: "b" }),
  ).rejects.toThrow(/terminated unexpectedly/);
  expect(terminated).toEqual(["i-dead"]);
});
