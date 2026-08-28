import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readProductionObserveCredentials } from "../services/core-api/src/production-observe-credentials.ts";
import { createProductionObserveHandler } from "../services/core-api/src/production-observe.ts";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_LOCAL_PORT = 8787;
const DEFAULT_LOCAL_TOKEN = "111";

if (Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error(
    `Beautio production observe requires Node.js 24; current runtime is ${process.version}`,
  );
}

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const webRoot = join(repositoryRoot, ".local", "production-observe-web");
const localPort = localPortFromEnvironment();
const localToken =
  optionalEnvironment("BEAUTIO_PROD_OBSERVE_LOCAL_TOKEN") ??
  DEFAULT_LOCAL_TOKEN;
const credentialsPath = resolve(
  repositoryRoot,
  optionalEnvironment("BEAUTIO_PROD_OBSERVE_CREDENTIALS") ??
    join(".local", "beautio-production-credentials.txt"),
);
const expectedProductionOrigin = requiredEnvironment(
  "BEAUTIO_PROD_OBSERVE_EXPECTED_ORIGIN",
);

await assertPortAvailable(LOCAL_HOST, localPort);
const credentials = await readProductionObserveCredentials(credentialsPath);
await runBuild();

const server = createHttpServer(
  createProductionObserveHandler({
    localBearerToken: localToken,
    productionAdminBearerToken: credentials.productionAdminBearerToken,
    productionOrigin: credentials.productionOrigin,
    expectedProductionOrigin,
    webRoot,
  }),
);

await listen(server, LOCAL_HOST, localPort);

console.log("Beautio production observe (read-only)");
console.log(`URL: http://${LOCAL_HOST}:${localPort}`);
console.log(
  localToken === DEFAULT_LOCAL_TOKEN
    ? `Local read-only key: ${DEFAULT_LOCAL_TOKEN}`
    : "Local read-only key: custom local value",
);
console.log("Production credentials remain inside this local process.");
console.log("Allowed upstream routes: inventory GET and protected image GET only.");

let stopping = false;
const stop = (): void => {
  if (stopping) {
    return;
  }
  stopping = true;
  server.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await waitForClose(server);

function localPortFromEnvironment(): number {
  const configured = optionalEnvironment("BEAUTIO_PROD_OBSERVE_PORT");
  if (configured === undefined) {
    return DEFAULT_LOCAL_PORT;
  }
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("BEAUTIO_PROD_OBSERVE_PORT must be an integer from 1 to 65535");
  }
  return parsed;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function requiredEnvironment(name: string): string {
  const value = optionalEnvironment(name);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", (error) => {
      rejectPromise(
        new Error(
          `Cannot start production observe because ${host}:${port} is already in use`,
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
    VITE_BEAUTIO_RUNTIME_MODE: "production-observe",
  };
  const packageManagerEntry = process.env.npm_execpath;
  const buildArguments = [
    "--filter",
    "@beautio/web",
    "exec",
    "vite",
    "build",
    "--outDir",
    webRoot,
    "--emptyOutDir",
  ];
  const build =
    packageManagerEntry === undefined
      ? spawn(pnpmCommand(), buildArguments, {
          cwd: repositoryRoot,
          env: buildEnvironment,
          stdio: "inherit",
        })
      : spawn(process.execPath, [packageManagerEntry, ...buildArguments], {
          cwd: repositoryRoot,
          env: buildEnvironment,
          stdio: "inherit",
        });
  const result = await childResult(build, "Beautio production-observe build");
  if (result.code !== 0) {
    throw new Error(
      result.signal === null
        ? `Beautio production-observe build failed with exit code ${result.code}`
        : `Beautio production-observe build stopped after ${result.signal}`,
    );
  }
}

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => rejectPromise(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

async function waitForClose(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("close", resolvePromise);
    server.once("error", rejectPromise);
  });
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
