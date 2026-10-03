import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, realpathSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { deliveryClockPath, deliveryClockRead, deliveryClockStamp } from "../src/delivery-clock";
import { acquirePathLock } from "../src/panelock";
import { removeScratchTree } from "./support/scratch";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "delivery-clock-native-")));
afterAll(() => removeScratchTree(scratch));
const registry = join(scratch, "registry.json"); writeFileSync(registry, "{}");
const module = resolve(import.meta.dir, "../src/delivery-clock.ts");
function child(command: string, args: string[]) {
  const proc = spawn(command, args, { env: process.env, stdio: "ignore" });
  return new Promise<number | null>((done, reject) => { proc.on("error", reject); proc.on("close", done); });
}
test("clock preserves large integer precision, float rejection, monotonic bytes and private mode", () => {
  const path = deliveryClockPath(registry, "large");
  deliveryClockStamp(registry, "large", "9007199254740993");
  expect(deliveryClockRead(registry, "large")).toBe("9007199254740993");
  const before = statSync(path);
  deliveryClockStamp(registry, "large", "9007199254740992");
  expect(statSync(path).ino).toBe(before.ino);
  expect(deliveryClockRead(registry, "large")).toBe("9007199254740993");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  for (const value of ["true", "1.0", "1e2", "null", '"+2"', '"1_0"']) {
    writeFileSync(path, `{"last_delivered_at":${value}}`);
    expect(deliveryClockRead(registry, "large")).toBe("");
  }
  writeFileSync(path, '{"last_delivered_at":" -٦٠ "}');
  expect(deliveryClockRead(registry, "large")).toBe("-60");
  writeFileSync(path, JSON.stringify({ last_delivered_at: " \u001c123\u001f " }));
  expect(deliveryClockRead(registry, "large")).toBe("123");
});
test("unbound clocks do nothing and post-flip paths require the nested bus", () => {
  expect(deliveryClockPath("", "peer")).toBe(""); deliveryClockStamp("", "peer", "60");
  expect(deliveryClockRead("", "peer")).toBe("");
  const parent = join(scratch, ".tap"); mkdirSync(parent);
  const reg = join(parent, "team-registry.json");
  expect(deliveryClockPath(reg, "team/peer")).toBe(join(parent, "delivery/peer.json"));
  mkdirSync(join(parent, "bus"));
  expect(deliveryClockPath(reg, "team/peer")).toBe(join(parent, "bus/delivery/peer.json"));
  const target = join(scratch, "target"); mkdirSync(target);
  const link = join(scratch, "link.json"); symlinkSync(join(target, "absent.json"), link);
  expect(deliveryClockPath(link, "peer")).toBe(join(target, "delivery/peer.json"));
  const obstructed = join(scratch, "file"); writeFileSync(obstructed, "file");
  expect(() => deliveryClockStamp(join(obstructed, "registry.json"), "peer", "60")).not.toThrow();
});
test("a bound recipient bus owns the clock and a qualified handle names the same file", () => {
  const bus = join(scratch, "recipient-bus"); mkdirSync(bus);
  const reg = join(bus, "registry.json"); writeFileSync(reg, "{}");
  const path = deliveryClockPath(reg, "peer");
  expect(path).toBe(join(bus, "delivery", "peer.json"));
  expect(deliveryClockPath(reg, "tap/peer")).toBe(path);
  deliveryClockStamp(reg, "peer", "1788000000");
  expect(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort()).toEqual(["handle", "last_delivered_at"]);
  expect(deliveryClockRead(reg, "peer")).toBe("1788000000");
  deliveryClockStamp(reg, "peer", "1788000600");
  expect(deliveryClockRead(reg, "peer")).toBe("1788000600");
});
test("an unstamped seat, a damaged clock and an empty handle all read inert", () => {
  expect(deliveryClockRead(registry, "never-heard-from")).toBe("");
  const bad = deliveryClockPath(registry, "corrupt"); mkdirSync(dirname(bad), { recursive: true });
  for (const bytes of ["not json at all", '{"last_delivered_at":"soon"}', '{"last_delivered_at":true}']) {
    writeFileSync(bad, bytes);
    expect(deliveryClockRead(registry, "corrupt")).toBe("");
  }
  expect(deliveryClockPath(registry, "")).toBe("");
});
test("an unbound stamp through the module door writes nothing near the working directory", () => {
  const probe = join(scratch, "cwd-probe", "inner"); mkdirSync(probe, { recursive: true });
  const stamp = Bun.spawnSync([process.execPath, module, "stamp", "", "peer", "1788009999"], { cwd: probe, stdout: "pipe", stderr: "pipe" });
  expect(stamp.exitCode).toBe(0);
  const read = Bun.spawnSync([process.execPath, module, "read", "", "peer"], { cwd: probe, stdout: "pipe", stderr: "pipe" });
  expect(read.stdout.toString()).toBe("");
  expect(readdirSync(probe)).toEqual([]);
  expect(readdirSync(dirname(probe))).toEqual(["inner"]);
});
const python = `import fcntl,json,os,sys,tempfile
path,epoch=sys.argv[1],int(sys.argv[2])
with open(path+'.lock','w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 try: prior=json.load(open(path)).get('last_delivered_at')
 except Exception: prior=None
 if isinstance(prior,int) and not isinstance(prior,bool) and prior>epoch: sys.exit(0)
 fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path))
 with os.fdopen(fd,'w') as f: json.dump({'handle':'race','last_delivered_at':epoch},f,separators=(',',':'))
 os.replace(tmp,path)
`;
test("Python and Bun concurrent writers share flock and retain the greatest stamp", async () => {
  const path = deliveryClockPath(registry, "race"); mkdirSync(join(scratch, "delivery"), { recursive: true });
  const lock = acquirePathLock(`${path}.lock`); expect(lock).not.toBeNull();
  const jobs = [child("python3", ["-c", python, path, "200"]), child(process.execPath, [module, "stamp", registry, "race", "100"])];
  await Bun.sleep(100);
  expect(existsSync(path)).toBe(false); // Neither language may write through the holder.
  lock!.release();
  expect(await Promise.all(jobs)).toEqual([0, 0]);
  expect(deliveryClockRead(registry, "race")).toBe("200");
  const writers = Array.from({ length: 8 }, (_, i) => i % 2
    ? child("python3", ["-c", python, path, String(300 + i)])
    : child(process.execPath, [module, "stamp", registry, "race", String(300 + i)]));
  expect(await Promise.all(writers)).toEqual(Array(8).fill(0));
  expect(deliveryClockRead(registry, "race")).toBe("307");
  expect(JSON.parse(readFileSync(path, "utf8")).last_delivered_at).toBe(307);
});
