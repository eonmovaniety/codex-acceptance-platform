import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceHomePaths } from "./paths.js";
import { ArtifactStore } from "./artifacts.js";
import { SqliteStore } from "./storage.js";
import { BaselineStore, type BaselineRequest } from "./visual.js";
import { RetentionManager } from "./retention.js";

export class DashboardApi {
  constructor(
    private readonly store: SqliteStore,
    private readonly artifacts: ArtifactStore,
    private readonly home: AcceptanceHomePaths,
  ) {}

  handle(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      this.send(response, 405, { error: "read-only dashboard API" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    try {
      if (url.pathname === "/" || url.pathname === "/dashboard") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(dashboardHtml);
        return;
      }
      if (url.pathname === "/health") {
        this.send(response, 200, { ok: true, service: "cap-dashboard-api" });
        return;
      }
      if (
        parts.length === 3 &&
        parts[0] === "api" &&
        parts[1] === "automation" &&
        parts[2] === "jobs"
      ) {
        const notifications = this.store
          .listNotificationOutbox(["PENDING", "SENDING", "FAILED", "SENT"])
          .map((item) => this.notificationView(item));
        this.send(response, 200, {
          jobs: this.store.listAutomationJobs(),
          notifications,
        });
        return;
      }
      if (parts.length === 2 && parts[0] === "api" && parts[1] === "projects") {
        this.send(response, 200, { projects: this.store.listProjects() });
        return;
      }
      if (parts.length >= 3 && parts[0] === "api" && parts[1] === "projects") {
        const projectId = parts[2]!;
        if (parts.length === 4 && parts[3] === "runs") {
          this.send(response, 200, {
            project_id: projectId,
            runs: this.store.listRuns(projectId),
          });
          return;
        }
        if (parts.length === 4 && parts[3] === "automation") {
          const jobs = this.store.listAutomationJobs(projectId);
          const jobIds = new Set(jobs.map((job) => job.id));
          const notifications = this.store
            .listNotificationOutbox(["PENDING", "SENDING", "FAILED", "SENT"])
            .filter(
              (item) =>
                (item.jobId !== undefined && jobIds.has(item.jobId)) ||
                (item.runId !== undefined &&
                  jobs.some((job) => job.runId === item.runId)),
            )
            .map((item) => this.notificationView(item));
          this.send(response, 200, {
            project_id: projectId,
            jobs,
            notifications,
          });
          return;
        }
        this.send(response, 200, { project: this.store.getProject(projectId) });
        return;
      }
      if (parts.length >= 3 && parts[0] === "api" && parts[1] === "runs") {
        const runId = parts[2]!;
        const run = this.store.getRun(runId);
        if (parts.length === 3) {
          this.send(response, 200, {
            run,
            automation_job: this.store.findAutomationJobByRunId(runId),
            events: this.store.listEvents(runId),
            notifications: this.store
              .listNotificationOutbox(["PENDING", "SENDING", "FAILED", "SENT"])
              .filter((item) => item.runId === runId)
              .map((item) => this.notificationView(item)),
            artifacts: this.artifacts.listRelativePaths(
              run.projectId,
              run.taskId,
              run.id,
            ),
          });
          return;
        }
        if (parts[3] === "timeline" && parts.length === 4) {
          this.send(response, 200, {
            run_id: runId,
            events: this.store.listEvents(runId),
          });
          return;
        }
        if (parts[3] === "coverage" && parts.length === 4) {
          this.send(response, 200, {
            run_id: runId,
            available: this.artifacts.exists(
              run.projectId,
              run.taskId,
              run.id,
              "acceptance/matrix.json",
            ),
            matrix: this.readJsonIfPresent(
              run.projectId,
              run.taskId,
              run.id,
              "acceptance/matrix.json",
            ),
          });
          return;
        }
        if (parts[3] === "artifacts" && parts.length === 4) {
          this.send(response, 200, {
            run_id: runId,
            artifacts: this.artifacts.listRelativePaths(
              run.projectId,
              run.taskId,
              run.id,
            ),
          });
          return;
        }
        if (parts[3] === "artifacts" && parts.length >= 5) {
          const artifactPath = parts.slice(4).join("/");
          const buffer = this.artifacts.readBuffer(
            run.projectId,
            run.taskId,
            run.id,
            artifactPath,
          );
          response.writeHead(200, {
            "content-type": contentType(artifactPath),
            "cache-control": "no-store",
          });
          response.end(buffer);
          return;
        }
        this.send(response, 404, { error: "route not found" });
        return;
      }
      if (parts.length === 2 && parts[0] === "api" && parts[1] === "human") {
        this.send(response, 200, { requests: this.listHumanRequests() });
        return;
      }
      if (
        parts.length === 2 &&
        parts[0] === "api" &&
        parts[1] === "retention"
      ) {
        this.send(response, 200, {
          plan: new RetentionManager(this.home, this.store).plan(),
        });
        return;
      }
      this.send(response, 404, { error: "route not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send(response, message.includes("not found") ? 404 : 400, {
        error: message,
      });
    }
  }

  private readJsonIfPresent(
    projectId: string,
    taskId: string,
    runId: string,
    path: string,
  ): unknown {
    if (!this.artifacts.exists(projectId, taskId, runId, path)) return null;
    return JSON.parse(
      this.artifacts.readText(projectId, taskId, runId, path),
    ) as unknown;
  }

  private listHumanRequests(): BaselineRequest[] {
    const root = join(this.home.baselinesCache, "requests");
    try {
      return readdirSync(root)
        .filter((name) => name.endsWith(".json"))
        .map(
          (name) =>
            JSON.parse(
              readFileSync(join(root, name), "utf8"),
            ) as BaselineRequest,
        )
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
    } catch {
      return [];
    }
  }

  private notificationView(
    item: ReturnType<SqliteStore["getNotificationOutbox"]>,
  ) {
    return {
      ...item,
      deliveries: this.store.listNotificationDeliveries(item.id),
    };
  }

  private send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`${JSON.stringify(body)}\n`);
  }
}

export class DashboardServer {
  private server?: Server;

  constructor(private readonly api: DashboardApi) {}

  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    this.server = createServer((request, response) =>
      this.api.handle(request, response),
    );
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        const address = this.server!.address();
        if (!address || typeof address === "string") {
          reject(new Error("Dashboard server did not expose a TCP address"));
          return;
        }
        resolve(address.port);
      });
    });
  }

  close(): Promise<void> {
    if (!this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function contentType(path: string): string {
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".log") || path.endsWith(".txt"))
    return "text/plain; charset=utf-8";
  if (path.endsWith(".rgba")) return "application/octet-stream";
  return "application/octet-stream";
}

const dashboardHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CAP Dashboard</title>
    <style>
      :root { color-scheme: dark; font: 16px system-ui, sans-serif; }
      body { margin: 0; padding: 2rem; background: #111827; color: #e5e7eb; }
      main { max-width: 72rem; margin: auto; }
      article { border: 1px solid #374151; border-radius: .75rem; padding: 1rem; margin: 1rem 0; background: #1f2937; }
      code { color: #93c5fd; }
      .muted { color: #9ca3af; }
    </style>
  </head>
  <body>
    <main>
      <h1>Codex Acceptance Platform</h1>
      <p class="muted">Read-only local view of projects, Runs, coverage, artifacts, and Human requests.</p>
      <section id="content">Loading…</section>
    </main>
    <script>
      async function load() {
        const content = document.getElementById('content');
        const [projects, human] = await Promise.all([
          fetch('/api/projects').then((response) => response.json()),
          fetch('/api/human').then((response) => response.json())
        ]);
        content.innerHTML = '';
        for (const project of projects.projects) {
          const card = document.createElement('article');
          const title = document.createElement('h2');
          title.textContent = project.name;
          const identifier = document.createElement('p');
          const code = document.createElement('code');
          code.textContent = project.id;
          identifier.appendChild(code);
          card.append(title, identifier);
          const automation = await fetch('/api/projects/' + encodeURIComponent(project.id) + '/automation').then((response) => response.json());
          const jobs = document.createElement('p');
          jobs.textContent = 'Automation jobs: ' + automation.jobs.length;
          card.appendChild(jobs);
          const notifications = document.createElement('p');
          const sent = automation.notifications.filter((item) => item.status === 'SENT').length;
          notifications.textContent = 'Notifications: ' + sent + '/' + automation.notifications.length + ' sent';
          card.appendChild(notifications);
          for (const job of automation.jobs.slice(-5).reverse()) {
            const row = document.createElement('p');
            row.className = 'muted';
            row.textContent = job.id + ' · ' + job.status + (job.runId ? ' · ' + job.runId : '');
            card.appendChild(row);
          }
          for (const notification of automation.notifications.slice(-5).reverse()) {
            const row = document.createElement('p');
            row.className = 'muted';
            const deliveries = notification.deliveries.map((delivery) => delivery.channel + '=' + delivery.status).join(', ');
            row.textContent = notification.eventType + ' · ' + notification.status + (deliveries ? ' · ' + deliveries : '');
            card.appendChild(row);
          }
          content.appendChild(card);
        }
        const humans = document.createElement('article');
        const humanTitle = document.createElement('h2');
        humanTitle.textContent = 'Human requests';
        const humanCount = document.createElement('p');
        humanCount.textContent = human.requests.length + ' pending or historical request(s)';
        humans.append(humanTitle, humanCount);
        content.appendChild(humans);
      }
      load().catch((error) => { document.getElementById('content').textContent = String(error); });
    </script>
  </body>
</html>`;
