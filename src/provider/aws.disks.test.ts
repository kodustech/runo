import { expect, test } from "bun:test";
import {
  CreateSnapshotCommand,
  CreateTagsCommand,
  DeleteTagsCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  ModifyVolumeCommand,
  RunInstancesCommand,
  StartInstancesCommand,
} from "@aws-sdk/client-ec2";
import { Ec2Provider, GP3_BASELINE, RETIRE_AT_TAG, RETIRE_SNAPSHOTS_TAG } from "./aws";

function providerWith(send: (cmd: any) => Promise<any>): Ec2Provider {
  const p = new Ec2Provider();
  (p as any).ec2 = { send };
  (p as any).pollMs = 1;
  return p;
}

const spec = { envName: "e", slug: "e", instanceType: "t3.xlarge", diskGb: 100, repo: "app", branch: "b" };
const oldDisk = { VolumeId: "vol-old", VolumeType: "gp3", Size: 100, Iops: 4000, Throughput: 300 };
const baseDisk = { VolumeId: "vol-base", VolumeType: "gp3", Size: 100, Iops: 3000, Throughput: 125 };

test("a new env and a bake VM get the free gp3 baseline, not paid IOPS or throughput", async () => {
  const launched: any[] = [];
  const p = providerWith(async (cmd) => {
    if (cmd instanceof RunInstancesCommand) {
      launched.push(cmd.input);
      return { Instances: [{ InstanceId: "i-new" }] };
    }
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  p.listManaged = async () => [];
  (p as any).ensureKeyPair = async () => {};
  (p as any).ensureSecurityGroup = async () => "sg-test";
  (p as any).claimFromPool = async () => null;
  (p as any).resolveAmi = async () => ({ amiId: "ami-1", rootDevice: "/dev/sda1", baked: true });
  (p as any).waitForState = async (id: string) => ({ id, state: "running", ip: "192.0.2.1" });
  await p.create(spec);
  const ebs = launched[0].BlockDeviceMappings[0].Ebs;
  expect(ebs).toMatchObject({ VolumeType: "gp3", Iops: 3000, Throughput: 125 });
  expect(GP3_BASELINE).toEqual({ iops: 3000, throughputMBps: 125 });
});

test("settling moves only disks above the baseline and keeps going when one refuses", async () => {
  const modified: any[] = [];
  const p = providerWith(async (cmd) => {
    if (cmd instanceof DescribeVolumesCommand)
      return { Volumes: [oldDisk, baseDisk, { ...oldDisk, VolumeId: "vol-cooldown" }, { ...oldDisk, VolumeId: "vol-io2", VolumeType: "io2" }, { ...oldDisk, VolumeId: "vol-thr", Iops: 3000 }] };
    if (cmd instanceof ModifyVolumeCommand) {
      if (cmd.input.VolumeId === "vol-cooldown")
        throw Object.assign(new Error("modified in the last 6 hours"), { name: "VolumeModificationRateExceeded" });
      modified.push(cmd.input);
      return {};
    }
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  expect(await p.settleDiskPerformance()).toBe(2);
  expect(modified).toEqual([
    { VolumeId: "vol-old", Iops: 3000, Throughput: 125 },
    { VolumeId: "vol-thr", Iops: 3000, Throughput: 125 },
  ]);
});

test("settling the whole install lists only this install's volumes, and a denied listing changes nothing", async () => {
  let filters: any;
  const p = providerWith(async (cmd) => {
    if (cmd instanceof DescribeVolumesCommand) {
      filters = cmd.input.Filters;
      throw Object.assign(new Error("not authorized"), { name: "UnauthorizedOperation" });
    }
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  expect(await p.settleDiskPerformance()).toBe(0);
  expect(filters.map((f: any) => f.Name)).toEqual(["tag:runo:managed", "tag:runo:home-hash"]);
});

test("resuming a stopped env moves its disk to the baseline before starting it", async () => {
  const calls: string[] = [];
  const p = providerWith(async (cmd) => {
    calls.push(cmd.constructor.name);
    if (cmd instanceof DescribeVolumesCommand) {
      expect(cmd.input.Filters).toEqual([{ Name: "attachment.instance-id", Values: ["i-stopped"] }]);
      return { Volumes: [oldDisk] };
    }
    if (cmd instanceof ModifyVolumeCommand || cmd instanceof StartInstancesCommand) return {};
    if (cmd instanceof DescribeInstancesCommand)
      return { Reservations: [{ Instances: [{ InstanceId: "i-stopped", State: { Name: "running" }, PublicIpAddress: "192.0.2.1" }] }] };
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  p.listManaged = async () => [];
  expect(await p.resume({ id: "i-stopped", ip: null, state: "stopped" })).toMatchObject({ state: "running" });
  expect(calls.slice(0, 3)).toEqual(["DescribeVolumesCommand", "ModifyVolumeCommand", "StartInstancesCommand"]);
});

test("resuming still starts the env when its disk cannot change yet", async () => {
  let started = false;
  const p = providerWith(async (cmd) => {
    if (cmd instanceof DescribeVolumesCommand) return { Volumes: [oldDisk] };
    if (cmd instanceof ModifyVolumeCommand) throw Object.assign(new Error("in progress"), { name: "IncorrectModificationState" });
    if (cmd instanceof StartInstancesCommand) { started = true; return {}; }
    if (cmd instanceof DescribeInstancesCommand)
      return { Reservations: [{ Instances: [{ InstanceId: "i-1", State: { Name: "running" }, PublicIpAddress: "192.0.2.1" }] }] };
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  p.listManaged = async () => [];
  await p.resume({ id: "i-1", ip: null, state: "stopped" });
  expect(started).toBe(true);
});

function poolProvider(volume: object, onModify: (input: any) => void) {
  const p = providerWith(async (cmd) => {
    if (cmd instanceof CreateTagsCommand || cmd instanceof DeleteTagsCommand || cmd instanceof StartInstancesCommand) return {};
    if (cmd instanceof DescribeVolumesCommand) return { Volumes: [volume] };
    if (cmd instanceof ModifyVolumeCommand) { onModify(cmd.input); return {}; }
    if (cmd instanceof DescribeInstancesCommand)
      return { Reservations: [{ Instances: [{ InstanceId: "i-pool", State: { Name: "running" }, PublicIpAddress: "192.0.2.1" }] }] };
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  (p as any).listPool = async () => [{ id: "i-pool", ip: null, state: "stopped", instanceType: "t3.xlarge" }];
  return p;
}

test("claiming a pool instance grows and settles its disk in one modification", async () => {
  const mods: any[] = [];
  const p = poolProvider({ ...oldDisk, Size: 50 }, (i) => mods.push(i));
  await (p as any).claimFromPool(spec);
  expect(mods).toEqual([{ VolumeId: "vol-old", Size: 100, Iops: 3000, Throughput: 125 }]);
});

test("a pool claim survives a refused baseline change but not a refused grow", async () => {
  const refuse = (input: any) => { throw Object.assign(new Error(`no ${JSON.stringify(input)}`), { name: "UnauthorizedOperation" }); };
  expect(await (poolProvider(oldDisk, refuse) as any).claimFromPool(spec)).toMatchObject({ id: "i-pool" });
  await expect((poolProvider({ ...oldDisk, Size: 50 }, refuse) as any).claimFromPool(spec)).rejects.toThrow("no ");
});

test("a retire snapshot keeps the env's tags and marks the instance with what to wait for", async () => {
  const snapshots: any[] = [];
  let mark: any;
  const p = providerWith(async (cmd) => {
    if (cmd instanceof DescribeInstancesCommand)
      return { Reservations: [{ Instances: [{ InstanceId: "i-1", Tags: [
        { Key: "Name", Value: "runo-abc-feat" }, { Key: "runo:branch", Value: "feat" }, { Key: "team", Value: "x" },
        { Key: RETIRE_SNAPSHOTS_TAG, Value: "snap-stale" },
      ] }] }] };
    if (cmd instanceof DescribeVolumesCommand) return { Volumes: [oldDisk, baseDisk] };
    if (cmd instanceof CreateSnapshotCommand) { snapshots.push(cmd.input); return { SnapshotId: `snap-${snapshots.length}` }; }
    if (cmd instanceof CreateTagsCommand) { mark = cmd.input; return {}; }
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  const ids = await p.snapshotForRetire({ id: "i-1", ip: null, state: "stopped", name: "runo-abc-feat" }, [{ Key: "cleanup", Value: "runo-retired-2026-11-24" }]);
  expect(ids).toEqual(["snap-1", "snap-2"]);
  expect(snapshots.map((s) => s.VolumeId)).toEqual(["vol-old", "vol-base"]);
  expect(snapshots[0].TagSpecifications[0].Tags).toEqual([
    { Key: "Name", Value: "runo-abc-feat" }, { Key: "runo:branch", Value: "feat" }, { Key: "cleanup", Value: "runo-retired-2026-11-24" },
  ]);
  expect(mark.Resources).toEqual(["i-1"]);
  expect(mark.Tags[0]).toEqual({ Key: RETIRE_SNAPSHOTS_TAG, Value: "snap-1,snap-2" });
  expect(mark.Tags[1].Key).toBe(RETIRE_AT_TAG);
});

test("retire snapshots read as completed, pending or failed", async () => {
  const states = (list: any[] | Error) => providerWith(async (cmd) => {
    if (!(cmd instanceof DescribeSnapshotsCommand)) throw new Error(`unexpected ${cmd.constructor.name}`);
    if (list instanceof Error) throw list;
    return { Snapshots: list };
  });
  const ids = ["snap-1", "snap-2"];
  expect(await states([{ State: "completed" }, { State: "completed" }]).retireSnapshotsState(ids)).toBe("completed");
  expect(await states([{ State: "completed" }, { State: "pending" }]).retireSnapshotsState(ids)).toBe("pending");
  expect(await states([{ State: "completed" }, { State: "error" }]).retireSnapshotsState(ids)).toBe("failed");
  expect(await states([{ State: "completed" }]).retireSnapshotsState(ids)).toBe("failed");
  expect(await states(Object.assign(new Error("gone"), { name: "InvalidSnapshot.NotFound" })).retireSnapshotsState(ids)).toBe("failed");
});

test("the listing carries a retire in progress", async () => {
  const p = providerWith(async () => ({ Reservations: [{ Instances: [{
    InstanceId: "i-1", State: { Name: "stopped" },
    Tags: [{ Key: RETIRE_SNAPSHOTS_TAG, Value: "snap-1,snap-2" }, { Key: RETIRE_AT_TAG, Value: "2026-11-20T00:00:00.000Z" }],
  }] }] }));
  expect((await p.listManaged())[0]).toMatchObject({ retireSnapshots: ["snap-1", "snap-2"], retireAt: "2026-11-20T00:00:00.000Z" });
});
