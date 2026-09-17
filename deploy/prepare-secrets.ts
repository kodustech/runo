// Run locally after check-isolated-access.sh. Outputs stay in ignored, 0700 storage.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const dir = ".runo-deploy";
mkdirSync(dir, { mode: 0o700, recursive: true });
if (existsSync(`${dir}/server.env`)) throw new Error("Secrets already prepared; refusing to rotate implicitly");
const result = Bun.spawnSync(["aws", "configure", "export-credentials", "--profile", "kodus-devops-agent", "--format", "process"], { stdout: "pipe", stderr: "pipe" });
if (result.exitCode !== 0) throw new Error("Could not load the dedicated AWS profile");
const credentials = JSON.parse(result.stdout.toString());
if (!credentials.AccessKeyId || !credentials.SecretAccessKey) throw new Error("Missing dedicated credentials");
const ci = randomBytes(32).toString("hex");
const qa = randomBytes(32).toString("hex");
const save = (name: string, value: string) => writeFileSync(`${dir}/${name}`, value, { mode: 0o600 });
save("aws.env", `AWS_ACCESS_KEY_ID=${credentials.AccessKeyId}\nAWS_SECRET_ACCESS_KEY=${credentials.SecretAccessKey}\n${credentials.SessionToken ? `AWS_SESSION_TOKEN=${credentials.SessionToken}\n` : ""}`);
save("server.env", (await Bun.file("deploy/isolated.env.example").text()) + `\nRUNO_AWS_AMI=ami-00adec9774170bad2\nRUNO_AWS_SUBNET=subnet-01dc4f334604de654\nRUNO_SERVER_TOKENS=preview-ci:${ci},qa:${qa}\n`);
save("ci-token", ci);
save("qa.env", `export RUNO_SERVER=https://3-14-180-98.sslip.io\nexport RUNO_TOKEN=${qa}\n`);
console.log("Dedicated AWS credentials and separate CI/QA tokens prepared; values not printed.");
