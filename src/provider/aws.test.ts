import { expect, test } from "bun:test";
import { DescribeInstancesCommand, RunInstancesCommand, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { Ec2Provider } from "./aws";
import { MAX_INSTANCES } from "../config";

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

function capacityProvider(states: string[], limit?: () => number | undefined) {
  const p = new Ec2Provider(limit ? { runningInstanceLimit: limit } : {});
  let launches = 0;
  (p as any).ec2 = { send: async (cmd: any) => {
    if (!(cmd instanceof DescribeInstancesCommand)) throw new Error(`unexpected ${cmd.constructor.name}`);
    return { Reservations: [{ Instances: states.map((state, i) => ({ InstanceId: `i-${i}`, State: { Name: state } })) }] };
  }};
  (p as any).ensureKeyPair = async () => {};
  (p as any).ensureSecurityGroup = async () => "sg-test";
  (p as any).claimFromPool = async () => {
    launches++;
    return { id: "i-claimed", ip: "192.0.2.1", state: "running" };
  };
  return { p, launches: () => launches };
}

const capacitySpec = { envName: "capacity", slug: "capacity", instanceType: "t3.medium", diskGb: 20, repo: "app", branch: "capacity" };

function launchProvider(send: (cmd: RunInstancesCommand) => Promise<any>) {
  const p = providerWith(async (cmd) => {
    if (!(cmd instanceof RunInstancesCommand)) throw new Error(`unexpected ${cmd.constructor.name}`);
    return send(cmd);
  });
  p.listManaged = async () => [];
  (p as any).ensureKeyPair = async () => {};
  (p as any).ensureSecurityGroup = async () => "sg-test";
  (p as any).claimFromPool = async () => null;
  (p as any).waitForState = async (id: string) => ({ id, state: "running", ip: "192.0.2.1" });
  return p;
}

for (const code of ["InvalidAMIID.NotFound", "InvalidAMIID.Unavailable"]) {
  for (const spot of [false, true]) {
    test(`a ${spot ? "spot" : "on-demand"} create resolves its image again after ${code}`, async () => {
      const launches: RunInstancesCommand["input"][] = [];
      let resolutions = 0;
      const p = launchProvider(async (cmd) => {
        launches.push(cmd.input);
        if (cmd.input.ImageId === "ami-retired") throw Object.assign(new Error("image retired"), { name: code });
        return { Instances: [{ InstanceId: "i-new" }] };
      });
      (p as any).resolveAmi = async (repo: string) => {
        expect(repo).toBe("app");
        return ++resolutions === 1
          ? { amiId: "ami-retired", rootDevice: "/dev/old", baked: true }
          : { amiId: "ami-current", rootDevice: "/dev/current", baked: false };
      };
      expect(await p.create({ ...capacitySpec, spot })).toMatchObject({ id: "i-new" });
      expect(resolutions).toBe(2);
      expect(launches.map((input) => input.ImageId)).toEqual(["ami-retired", "ami-current"]);
      expect(launches[0].UserData).toBeUndefined();
      expect(launches[1].UserData).toBeTruthy();
      expect(launches[1].BlockDeviceMappings?.[0]?.DeviceName).toBe("/dev/current");
    });
  }
}

test("retired-image recovery is bounded when the replacement also disappears", async () => {
  let resolutions = 0;
  let launches = 0;
  const p = launchProvider(async () => {
    launches++;
    throw Object.assign(new Error("image retired"), { name: "InvalidAMIID.Unavailable" });
  });
  (p as any).resolveAmi = async () => ({ amiId: `ami-${++resolutions}`, rootDevice: "/dev/sda1", baked: true });
  await expect(p.create(capacitySpec)).rejects.toThrow("image retired");
  expect(resolutions).toBe(2);
  expect(launches).toBe(2);
});

test("a missing canonical image and permission errors do not trigger image recovery", async () => {
  for (const [baked, code, message] of [[false, "InvalidAMIID.NotFound", "image missing"], [true, "UnauthorizedOperation", "no permission"]] as const) {
    let resolutions = 0;
    let launches = 0;
    const p = launchProvider(async () => {
      launches++;
      throw Object.assign(new Error(message), { name: code });
    });
    (p as any).resolveAmi = async () => { resolutions++; return { amiId: "ami-selected", rootDevice: "/dev/sda1", baked }; };
    await expect(p.create(capacitySpec)).rejects.toThrow(message);
    expect(resolutions).toBe(1);
    expect(launches).toBe(1);
  }
});

test("direct AWS CLI retains its configured instance guardrail", async () => {
  const { p, launches } = capacityProvider(Array(MAX_INSTANCES).fill("running"));
  await expect(p.create(capacitySpec)).rejects.toThrow(`max ${MAX_INSTANCES}`);
  expect(launches()).toBe(0);
});

test("a server policy of ten permits nine active machines and ignores stopped machines", async () => {
  const { p } = capacityProvider([...Array(5).fill("running"), ...Array(4).fill("pending"), ...Array(20).fill("stopped")], () => 10);
  expect(await p.create(capacitySpec)).toMatchObject({ id: "i-claimed" });
});

test("the server policy blocks a new machine at ten including pending machines", async () => {
  const { p, launches } = capacityProvider([...Array(9).fill("running"), "pending"], () => 10);
  await expect(p.create(capacitySpec)).rejects.toThrow("max 10");
  expect(launches()).toBe(0);
});

test("policy changes are read without recreating the provider and an empty policy is unlimited", async () => {
  let limit: number | undefined = 10;
  const { p } = capacityProvider(Array(11).fill("running"), () => limit);
  await expect(p.create(capacitySpec)).rejects.toThrow("max 10");
  limit = 12;
  expect(await p.create(capacitySpec)).toMatchObject({ id: "i-claimed" });
  limit = undefined;
  expect(await p.create(capacitySpec)).toMatchObject({ id: "i-claimed" });
});

test("resume respects the running limit before starting a stopped machine", async () => {
  const { p } = capacityProvider(Array(10).fill("running"), () => 10);
  await expect(p.resume({ id: "i-stopped", ip: null, state: "stopped" })).rejects.toThrow("max 10");
  // Starting an already-running machine at the limit is an idempotent no-op.
  expect(await p.resume({ id: "i-running", ip: "192.0.2.1", state: "running" })).toMatchObject({ state: "running" });
});

for (const state of ["running", "pending"] as const) {
  test(`resume waits for a public IP when the instance is already ${state}`, async () => {
    let describes = 0;
    const p = providerWith(async (cmd) => {
      if (!(cmd instanceof DescribeInstancesCommand)) throw new Error(`unexpected ${cmd.constructor.name}`);
      return { Reservations: [{ Instances: [{
        InstanceId: "i-starting", State: { Name: "running" },
        ...(++describes > 1 ? { PublicIpAddress: "192.0.2.1" } : {}),
      }] }] };
    });
    expect(await p.resume({ id: "i-starting", ip: null, state })).toMatchObject({ state: "running", ip: "192.0.2.1" });
    expect(describes).toBe(2);
  });
}

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
