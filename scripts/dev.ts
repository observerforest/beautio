import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const apiPort = parsePort(process.env.BEAUTIO_API_PORT, 8787, "BEAUTIO_API_PORT");
const webPort = parsePort(process.env.BEAUTIO_WEB_PORT, 4173, "BEAUTIO_WEB_PORT");
const databasePath =
  process.env.BEAUTIO_DB_PATH ??
  join(repositoryRoot, ".local", "beautio-validation.sqlite");
const imageStorageRoot =
  process.env.BEAUTIO_IMAGE_STORAGE_ROOT ??
  join(repositoryRoot, ".local", "managed-images");

requiredEnvironment("BEAUTIO_ACTION_BEARER_TOKEN");
requiredEnvironment("BEAUTIO_ADMIN_BEARER_TOKEN");
requiredEnvironment("BEAUTIO_ACTION_FILE_HOST_ALLOWLIST");

mkdirSync(dirname(databasePath), { recursive: true });
mkdirSync(imageStorageRoot, { recursive: true });

const childEnvironment = {
  ...process.env,
  BEAUTIO_API_PORT: String(apiPort),
  BEAUTIO_DB_PATH: databasePath,
  BEAUTIO_IMAGE_STORAGE_ROOT: imageStorageRoot,
  BEAUTIO_WEB_PORT: String(webPort),
};

const api = spawn(
  process.execPath,
  [join(repositoryRoot, "services/core-api/src/http.ts")],
  {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: "inherit",
  },
);
const web = spawn(
  process.execPath,
  [
    join(repositoryRoot, "apps/web/node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    String(webPort),
    "--strictPort",
  ],
  {
    cwd: join(repositoryRoot, "apps/web"),
    env: childEnvironment,
    stdio: "inherit",
  },
);

console.log(`Beautio local database: ${databasePath}`);
console.log(`Beautio inventory page: http://127.0.0.1:${webPort}`);

let stopping = false;
const children: readonly ChildProcess[] = [api, web];

function stopChildren(signal: NodeJS.Signals): void {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }
}

for (const child of children) {
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
    stopChildren("SIGTERM");
  });
  child.once("exit", (code, signal) => {
    if (stopping) {
      return;
    }
    console.error(
      `A Beautio development process stopped unexpectedly (${signal ?? code ?? "unknown"}).`,
    );
    process.exitCode = code === null || code === 0 ? 1 : code;
    stopChildren("SIGTERM");
  });
}

process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

function parsePort(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variableName} must be an integer between 1 and 65535`);
  }
  return port;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
