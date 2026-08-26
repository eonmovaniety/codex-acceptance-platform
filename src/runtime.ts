import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ResourceLease } from "./domain.js";
import { CapError } from "./errors.js";
import type { AcceptanceHomePaths } from "./paths.js";
import { SqliteStore, type Clock, systemClock } from "./storage.js";

const markerName = ".cap-runtime.json";

export interface RuntimeRecord {
  runId: string;
  projectId: string;
  taskId: string;
  path: string;
  port: number;
  markerPath: string;
  state: "ALLOCATED" | "RELEASED";
}

export class RuntimeManager {
  constructor(
    private readonly home: AcceptanceHomePaths,
    private readonly store: SqliteStore,
    private readonly clock: Clock = systemClock,
  ) {}

  allocate(
    projectId: string,
    taskId: string,
    runId: string,
    requestedPort?: number,
  ): RuntimeRecord {
    const path = resolve(this.home.runtime, runId);
    const relativePath = relative(resolve(this.home.runtime), path);
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      relativePath.startsWith(sep)
    ) {
      throw new CapError(
        `Runtime path is outside CAP runtime root: ${path}`,
        "PATH_OUTSIDE_MANAGED_ROOT",
      );
    }
    if (existsSync(path))
      throw new CapError(
        `Runtime already exists for ${runId}`,
        "RUNTIME_EXISTS",
      );
    mkdirSync(path, { recursive: true });
    const port = this.selectPort(requestedPort);
    const runtimeLease: ResourceLease = {
      id: randomUUID(),
      runId,
      resourceType: "runtime-dir",
      resourceKey: runId,
      status: "ACTIVE",
      expiresAt: new Date(
        Date.parse(this.clock.now()) + 60 * 60 * 1000,
      ).toISOString(),
    };
    const portLease: ResourceLease = {
      id: randomUUID(),
      runId,
      resourceType: "port",
      resourceKey: String(port),
      status: "ACTIVE",
      expiresAt: runtimeLease.expiresAt,
    };
    try {
      this.store.createLease(runtimeLease);
      this.store.createLease(portLease);
      const record: RuntimeRecord = {
        runId,
        projectId,
        taskId,
        path,
        port,
        markerPath: join(path, markerName),
        state: "ALLOCATED",
      };
      writeFileSync(
        record.markerPath,
        `${JSON.stringify({ marker: markerName, ...record }, null, 2)}\n`,
        "utf8",
      );
      mkdirSync(join(path, "tmp"), { recursive: true });
      mkdirSync(join(path, "logs"), { recursive: true });
      return record;
    } catch (error) {
      for (const lease of [runtimeLease, portLease]) {
        const saved = this.store.findActiveLease(
          lease.resourceType,
          lease.resourceKey,
        );
        if (saved?.id === lease.id) this.store.releaseLease(lease.id);
      }
      rmSync(path, { recursive: true, force: true });
      throw error;
    }
  }

  release(record: RuntimeRecord): void {
    const marker = this.readMarker(record);
    if (
      marker.runId !== record.runId ||
      resolve(marker.path) !== resolve(record.path) ||
      marker.port !== record.port
    ) {
      throw new CapError(
        `Runtime marker does not match run ${record.runId}`,
        "MARKER_MISMATCH",
      );
    }
    const leases = this.store
      .listLeases(record.runId)
      .filter((lease) => lease.status === "ACTIVE");
    for (const lease of leases) this.store.releaseLease(lease.id);
    if (existsSync(record.path))
      rmSync(record.path, { recursive: true, force: true });
  }

  private selectPort(requestedPort?: number): number {
    const base = requestedPort ?? 18_000;
    for (let offset = 0; offset < 1_000; offset += 1) {
      const port = base + offset;
      if (!this.store.findActiveLease("port", String(port))) return port;
    }
    throw new CapError(
      "No managed runtime port is available",
      "RESOURCE_EXHAUSTED",
    );
  }

  private readMarker(
    record: RuntimeRecord,
  ): RuntimeRecord & { marker?: string } {
    if (
      !resolve(record.path).startsWith(`${resolve(this.home.runtime)}${sep}`)
    ) {
      throw new CapError(
        `Runtime path is outside CAP runtime root: ${record.path}`,
        "PATH_OUTSIDE_MANAGED_ROOT",
      );
    }
    if (!existsSync(record.markerPath))
      throw new CapError(
        `Runtime marker is missing: ${record.markerPath}`,
        "INVALID_MARKER",
      );
    const value = JSON.parse(
      readFileSync(record.markerPath, "utf8"),
    ) as RuntimeRecord & { marker?: string };
    if (value.marker !== markerName)
      throw new CapError(
        `Invalid CAP runtime marker: ${record.markerPath}`,
        "INVALID_MARKER",
      );
    return value;
  }
}
