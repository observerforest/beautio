import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 8787;
const DEFAULT_ADMIN_TOKEN = "111";
const DEFAULT_ACTION_TOKEN = "local-action-token-not-production";

if (Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error(
    `Beautio local production requires Node.js 24; current runtime is ${process.version}`,
  );
}

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const webRoot = join(repositoryRoot, "apps", "web", "dist");
const databasePath = localPath(
  "BEAUTIO_LOCAL_DB_PATH",
  join(repositoryRoot, ".local", "beautio-validation.sqlite"),
);
const imageStorageRoot = localPath(
  "BEAUTIO_LOCAL_IMAGE_STORAGE_ROOT",
  join(repositoryRoot, ".local", "managed-images"),
);
const adminToken =
  optionalEnvironment("BEAUTIO_LOCAL_ADMIN_TOKEN") ?? DEFAULT_ADMIN_TOKEN;
const actionToken =
  optionalEnvironment("BEAUTIO_LOCAL_ACTION_TOKEN") ?? DEFAULT_ACTION_TOKEN;

if (adminToken === actionToken) {
  throw new Error("Local Admin and Action tokens must be different");
}

await assertPortAvailable(LOCAL_HOST, LOCAL_PORT);
await runBuild();

mkdirSync(dirname(databasePath), { recursive: true });
mkdirSync(imageStorageRoot, { recursive: true });

const serverEnvironment: NodeJS.ProcessEnv = { ...process.env };
for (const name of [
  "BEAUTIO_PUBLIC_ORIGIN",
  "BEAUTIO_REMOTE_MCP_HOST",
  "BEAUTIO_ACCESS_TEAM_DOMAIN",
  "BEAUTIO_ACCESS_AUDIENCE",
]) {
  delete serverEnvironment[name];
}
Object.assign(serverEnvironment, {
  NODE_ENV: "production",
  BEAUTIO_API_HOST: LOCAL_HOST,
  BEAUTIO_API_PORT: String(LOCAL_PORT),
  BEAUTIO_DB_PATH: databasePath,
  BEAUTIO_IMAGE_STORAGE_ROOT: imageStorageRoot,
  BEAUTIO_WEB_ROOT: webRoot,
  BEAUTIO_ACTION_BEARER_TOKEN: actionToken,
  BEAUTIO_ADMIN_BEARER_TOKEN: adminToken,
  BEAUTIO_ACTION_FILE_HOST_ALLOWLIST: "files.example.invalid",
  BEAUTIO_REMOTE_MCP_ENABLED: "false",
});

const server = spawn(
  process.execPath,
  [join(repositoryRoot, "services", "core-api", "src", "http.ts")],
  {
    cwd: repositoryRoot,
    env: serverEnvironment,
    stdio: "inherit",
  },
);

console.log("Beautio production-like localhost");
console.log(`URL: http://${LOCAL_HOST}:${LOCAL_PORT}`);
console.log(
  adminToken === DEFAULT_ADMIN_TOKEN
    ? `Admin key: ${DEFAULT_ADMIN_TOKEN} (local preview only)`
    : "Admin key: custom value from BEAUTIO_LOCAL_ADMIN_TOKEN",
);
console.log(`Database: ${databasePath}`);
console.log(`Managed images: ${imageStorageRoot}`);
console.log("Remote MCP and production public origin: disabled");

let stopping = false;

function stopServer(signal: NodeJS.Signals): void {
  if (stopping) {
    return;
  }
  stopping = true;
  if (server.exitCode === null && server.signalCode === null) {
    server.kill(signal);
  }
}

process.once("SIGINT", () => stopServer("SIGINT"));
process.once("SIGTERM", () => stopServer("SIGTERM"));

await waitForServer(server);

function localPath(name: string, fallback: string): string {
  const configured = optionalEnvironment(name);
  return configured === undefined ? fallback : resolve(repositoryRoot, configured);
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", (error) => {
      rejectPromise(
        new Error(
          `Cannot start production-like localhost because ${host}:${port} is already in use`,
          { cause: error },
        ),
      );
    });
    probe.listen(port, host, () => {
      probe.close((error) => {
        if (error === undefined) {
          resolvePromise();
        } else {
          rejectPromise(error);
        }
      });
    });
  });
}

async function runBuild(): Promise<void> {
  const buildEnvironment = {
    ...process.env,
    VITE_BEAUTIO_RUNTIME_MODE: "managed",
  };
  const packageManagerEntry = process.env.npm_execpath;
  const build =
    packageManagerEntry === undefined
      ? spawn(pnpmCommand(), ["build"], {
          cwd: repositoryRoot,
          env: buildEnvironment,
          stdio: "inherit",
        })
      : spawn(process.execPath, [packageManagerEntry, "build"], {
          cwd: repositoryRoot,
          env: buildEnvironment,
          stdio: "inherit",
        });
  const result = await childResult(build, "Beautio production build");
  if (result.code !== 0) {
    throw new Error(
      result.signal === null
        ? `Beautio production build failed with exit code ${result.code}`
        : `Beautio production build stopped after ${result.signal}`,
    );
  }
}

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const result = await childResult(child, "Beautio managed server");
  if (!stopping) {
    process.exitCode = result.code === 0 ? 1 : result.code;
  }
}

async function childResult(
  child: ChildProcess,
  label: string,
): Promise<{ readonly code: number; readonly signal: NodeJS.Signals | null }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    child.once("error", (error) =>
      rejectPromise(new Error(`${label} could not start`, { cause: error })),
    );
    child.once("exit", (code, signal) =>
      resolvePromise({ code: code ?? 1, signal }),
    );
  });
}
