import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import type { AcceptanceRun, Project, ProjectConfig } from "./domain.js";
import { loadProjectConfig } from "./config.js";
import { CapError } from "./errors.js";
import type { GitClient } from "./git.js";
import type { AcceptanceHomePaths } from "./paths.js";
import { ArtifactStore } from "./artifacts.js";
import { AutomationService } from "./automation.js";
import { SqliteStore } from "./storage.js";

export interface ForgejoProviderConfig {
  serverUrl: string;
  owner: string;
  repo: string;
  credentialRef: string;
  statusContext: string;
  mirrorRemote?: string;
}

interface ForgejoPullRequest {
  number: number;
  head: { sha: string };
  base: { ref: string };
}

interface ForgejoBranch {
  name: string;
  commit: { id: string };
}

export type ForgejoFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export function forgejoProviderConfig(
  config: ProjectConfig,
): ForgejoProviderConfig | undefined {
  const ci = config.automation?.ci;
  if (ci?.provider !== "forgejo-poll") return undefined;
  const required = {
    serverUrl: ci.server_url,
    owner: ci.owner,
    repo: ci.repo,
    credentialRef: ci.credential_ref,
    statusContext: ci.status_context,
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value)
      throw new CapError(
        `automation.ci.${snakeCase(key)} is required for forgejo-poll`,
        "FORGEJO_CONFIG_INVALID",
      );
  }
  let serverUrl: URL;
  try {
    serverUrl = new URL(required.serverUrl!);
  } catch {
    throw new CapError(
      "automation.ci.server_url must be an absolute URL",
      "FORGEJO_CONFIG_INVALID",
    );
  }
  if (!/^https?:$/.test(serverUrl.protocol))
    throw new CapError(
      "automation.ci.server_url must use http or https",
      "FORGEJO_CONFIG_INVALID",
    );
  if (!required.credentialRef!.startsWith("cap-secret://forgejo/"))
    throw new CapError(
      "automation.ci.credential_ref must use cap-secret://forgejo/<name>",
      "FORGEJO_CONFIG_INVALID",
    );
  return {
    serverUrl: serverUrl.toString().replace(/\/$/, ""),
    owner: required.owner!,
    repo: required.repo!,
    credentialRef: required.credentialRef!,
    statusContext: required.statusContext!,
    ...(ci.mirror_remote ? { mirrorRemote: ci.mirror_remote } : {}),
  };
}

export function forgejoSecretPath(
  home: AcceptanceHomePaths,
  credentialRef: string,
): string {
  const prefix = "cap-secret://forgejo/";
  if (!credentialRef.startsWith(prefix))
    throw new CapError(
      "Invalid Forgejo credential reference",
      "FORGEJO_SECRET_INVALID",
    );
  const name = credentialRef.slice(prefix.length);
  if (!/^[A-Za-z0-9._-]+$/.test(name))
    throw new CapError(
      "Invalid Forgejo credential name",
      "FORGEJO_SECRET_INVALID",
    );
  return join(home.secrets, "forgejo", `${name}.token`);
}

export function installForgejoSecret(
  home: AcceptanceHomePaths,
  credentialRef: string,
  sourcePath: string,
): string {
  const destination = forgejoSecretPath(home, credentialRef);
  const token = readFileSync(resolve(sourcePath), "utf8").trim();
  if (token.length < 20)
    throw new CapError(
      "Forgejo token file is empty or invalid",
      "FORGEJO_SECRET_INVALID",
    );
  mkdirSync(resolve(destination, ".."), { recursive: true });
  copyFileSync(resolve(sourcePath), destination);
  chmodSync(destination, 0o600);
  if (process.platform === "win32") {
    const acl = spawnSync(
      "icacls.exe",
      [
        destination,
        "/inheritance:r",
        "/grant:r",
        `${process.env.USERNAME ?? ""}:(R,W)`,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (acl.status !== 0) {
      rmSync(destination, { force: true });
      throw new CapError(
        `Could not restrict Forgejo token ACL: ${acl.stderr.trim()}`,
        "FORGEJO_SECRET_ACL_FAILED",
      );
    }
  }
  return destination;
}

export function uninstallForgejoSecret(
  home: AcceptanceHomePaths,
  credentialRef: string,
): boolean {
  const path = forgejoSecretPath(home, credentialRef);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export class ForgejoClient {
  constructor(
    private readonly config: ForgejoProviderConfig,
    private readonly token: string,
    private readonly request: ForgejoFetch = fetch,
  ) {}

  async verify(): Promise<{ login: string; repository: string }> {
    const user = await this.api<{ login: string }>("GET", "/api/v1/user");
    await this.api(
      "GET",
      `/api/v1/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`,
    );
    return {
      login: user.login,
      repository: `${this.config.owner}/${this.config.repo}`,
    };
  }

  async openPullRequests(): Promise<ForgejoPullRequest[]> {
    return this.api<ForgejoPullRequest[]>(
      "GET",
      `/api/v1/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/pulls?state=open&limit=50`,
    );
  }

  async branch(name: string): Promise<ForgejoBranch> {
    return this.api<ForgejoBranch>(
      "GET",
      `/api/v1/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/branches/${encodeURIComponent(name)}`,
    );
  }

  async status(
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    description: string,
  ): Promise<void> {
    await this.api(
      "POST",
      `/api/v1/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/statuses/${encodeURIComponent(sha)}`,
      {
        state,
        context: this.config.statusContext,
        description: description.slice(0, 140),
      },
    );
  }

  async comment(pr: number, body: string): Promise<void> {
    await this.api(
      "POST",
      `/api/v1/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/issues/${String(pr)}/comments`,
      { body },
    );
  }

  private async api<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.request(`${this.config.serverUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `token ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new CapError(
        `Forgejo API ${method} ${path} failed (${String(response.status)}): ${detail}`,
        "FORGEJO_API_FAILED",
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export interface ForgejoCoordinatorDependencies {
  store: SqliteStore;
  home: AcceptanceHomePaths;
  git: GitClient;
  request?: ForgejoFetch;
  fetchCommit?: (project: Project, sha: string) => void;
  mirror?: (project: Project, remote: string, acceptedCommit: string) => void;
}

export class ForgejoAutomationCoordinator {
  private readonly artifacts: ArtifactStore;

  constructor(private readonly dependencies: ForgejoCoordinatorDependencies) {
    this.artifacts = new ArtifactStore(dependencies.home);
  }

  async cycle(): Promise<void> {
    for (const project of this.dependencies.store.listProjects()) {
      const projectConfig = await loadProjectConfig(project.configPath);
      const provider = forgejoProviderConfig(projectConfig);
      if (!provider || projectConfig.automation?.enabled !== true) continue;
      await this.pollProject(project, projectConfig, provider);
      await this.publishProject(project, provider);
    }
  }

  async verify(project: Project): Promise<unknown> {
    const config = await loadProjectConfig(project.configPath);
    const provider = forgejoProviderConfig(config);
    if (!provider)
      throw new CapError(
        "Project does not use forgejo-poll",
        "FORGEJO_NOT_CONFIGURED",
      );
    const client = this.client(provider);
    const identity = await client.verify();
    const branch = await client.branch(project.baseBranch);
    return { provider, identity, branch: branch.name, head: branch.commit.id };
  }

  private async pollProject(
    project: Project,
    config: ProjectConfig,
    provider: ForgejoProviderConfig,
  ): Promise<void> {
    const client = this.client(provider);
    const pulls =
      config.automation?.ci?.pull_request === false
        ? []
        : await client.openPullRequests();
    const branch = await client.branch(project.baseBranch);
    const candidates = [
      ...pulls
        .filter((pull) => pull.base.ref === project.baseBranch)
        .map((pull) => ({
          sha: pull.head.sha,
          source: "ci_pull_request" as const,
          eventId: `forgejo:${provider.owner}/${provider.repo}:pr:${String(pull.number)}:${pull.head.sha}`,
        })),
      ...(config.automation?.ci?.push_branches?.includes(project.baseBranch) ===
      false
        ? []
        : [
            {
              sha: branch.commit.id,
              source: "ci_push" as const,
              eventId: `forgejo:${provider.owner}/${provider.repo}:push:${project.baseBranch}:${branch.commit.id}`,
            },
          ]),
    ];
    for (const candidate of candidates) {
      try {
        (this.dependencies.fetchCommit ?? fetchCommit)(project, candidate.sha);
        const taskId = config.automation?.tasks?.[0]?.task_id;
        if (!taskId)
          throw new CapError(
            "Forgejo automation task is missing",
            "FORGEJO_CONFIG_INVALID",
          );
        const result = await new AutomationService(this.dependencies).enqueue({
          projectId: project.id,
          taskId,
          commit: candidate.sha,
          source: candidate.source,
          eventId: candidate.eventId,
        });
        const runId = result.run?.id ?? result.job.runId;
        if (!runId) continue;
        const key = `${runId}:status:pending`;
        if (
          this.dependencies.store.getForgejoDelivery(key)?.status !== "SENT"
        ) {
          await client.status(candidate.sha, "pending", `CAP ${runId} queued`);
          this.recordDelivery(key, project.id, runId, "status", "SENT");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.dependencies.store.setForgejoState(
          project.id,
          "last_poll_error",
          message,
        );
      }
    }
    this.dependencies.store.setForgejoState(
      project.id,
      "last_poll_at",
      new Date().toISOString(),
    );
  }

  private async publishProject(
    project: Project,
    provider: ForgejoProviderConfig,
  ): Promise<void> {
    const client = this.client(provider);
    const prefix = `forgejo:${provider.owner}/${provider.repo}:`;
    for (const job of this.dependencies.store.listAutomationJobs(project.id)) {
      if (!job.eventId.startsWith(prefix) || !job.runId) continue;
      const run = this.dependencies.store.getRun(job.runId);
      const state = finalForgejoState(run);
      if (!state) continue;
      const key = `${run.id}:status:${state}`;
      if (this.dependencies.store.getForgejoDelivery(key)?.status !== "SENT") {
        try {
          await client.status(run.targetCommit, state, forgejoDescription(run));
          this.recordDelivery(key, project.id, run.id, "status", "SENT");
        } catch (error) {
          this.recordDelivery(
            key,
            project.id,
            run.id,
            "status",
            "FAILED",
            error instanceof Error ? error.message : String(error),
          );
          continue;
        }
      }
      const pr = pullRequestNumber(job.eventId);
      if (pr !== undefined) await this.publishComment(client, project, run, pr);
      if (
        run.triggerSource === "ci_push" &&
        run.status === "COMPLETED_PASS" &&
        provider.mirrorRemote
      ) {
        this.publishMirror(project, run, provider.mirrorRemote);
      }
    }
  }

  private async publishComment(
    client: ForgejoClient,
    project: Project,
    run: AcceptanceRun,
    pr: number,
  ): Promise<void> {
    const key = `${run.id}:comment:final`;
    if (this.dependencies.store.getForgejoDelivery(key)?.status === "SENT")
      return;
    const summary = this.artifacts.exists(
      project.id,
      run.taskId,
      run.id,
      "acceptance/summary.md",
    )
      ? this.artifacts.readText(
          project.id,
          run.taskId,
          run.id,
          "acceptance/summary.md",
        )
      : `# CAP ${run.id}\n\nStatus: **${run.status}**\n`;
    try {
      await client.comment(pr, `${summary}\n<!-- cap-run:${run.id} -->`);
      this.recordDelivery(key, project.id, run.id, "comment", "SENT");
    } catch (error) {
      this.recordDelivery(
        key,
        project.id,
        run.id,
        "comment",
        "FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private publishMirror(
    project: Project,
    run: AcceptanceRun,
    remote: string,
  ): void {
    const key = `${run.id}:mirror:${remote}`;
    if (this.dependencies.store.getForgejoDelivery(key)?.status === "SENT")
      return;
    try {
      (this.dependencies.mirror ?? mirrorAcceptedRefs)(
        project,
        remote,
        run.targetCommit,
      );
      this.recordDelivery(key, project.id, run.id, "mirror", "SENT");
    } catch (error) {
      this.recordDelivery(
        key,
        project.id,
        run.id,
        "mirror",
        "FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private client(config: ForgejoProviderConfig): ForgejoClient {
    const tokenPath = forgejoSecretPath(
      this.dependencies.home,
      config.credentialRef,
    );
    const token = readFileSync(tokenPath, "utf8").trim();
    if (!token)
      throw new CapError("Forgejo token is empty", "FORGEJO_SECRET_INVALID");
    return new ForgejoClient(config, token, this.dependencies.request ?? fetch);
  }

  private recordDelivery(
    key: string,
    projectId: string,
    runId: string,
    kind: string,
    status: "SENT" | "FAILED",
    detail?: string,
  ): void {
    this.dependencies.store.setForgejoDelivery({
      key,
      projectId,
      runId,
      kind,
      status,
      ...(detail === undefined ? {} : { detail }),
    });
  }
}

function finalForgejoState(
  run: AcceptanceRun,
): "success" | "failure" | "error" | undefined {
  if (run.status === "COMPLETED_PASS" && run.decision === "PASS")
    return "success";
  if (
    run.status === "COMPLETED_FAIL" ||
    run.status === "COMPLETED_HUMAN" ||
    run.status === "BLOCKED"
  )
    return "failure";
  if (
    run.status === "INFRA_FAILED" ||
    run.status === "INVALID" ||
    run.status === "CANCELLED"
  )
    return "error";
  return undefined;
}

function forgejoDescription(run: AcceptanceRun): string {
  return `CAP ${run.id}: ${run.decision ?? run.status}`;
}

function pullRequestNumber(eventId: string): number | undefined {
  const match = /:pr:(\d+):[0-9a-f]+$/i.exec(eventId);
  return match?.[1] ? Number(match[1]) : undefined;
}

function fetchCommit(project: Project, sha: string): void {
  const result = spawnSync(
    "git",
    ["-C", project.repoPath, "fetch", "--no-tags", "origin", sha],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0)
    throw new CapError(
      `Could not fetch Forgejo commit ${sha}: ${result.stderr.trim()}`,
      "FORGEJO_FETCH_FAILED",
    );
}

export function mirrorAcceptedRefs(
  project: Project,
  remote: string,
  acceptedCommit: string,
): void {
  const fetchResult = spawnSync(
    "git",
    [
      "-C",
      project.repoPath,
      "fetch",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/tags/*:refs/tags/*",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (fetchResult.status !== 0)
    throw new CapError(
      `GitHub backup mirror '${remote}' failed: ${fetchResult.stderr.trim()}`,
      "FORGEJO_MIRROR_FAILED",
    );
  const refs = spawnSync(
    "git",
    [
      "-C",
      project.repoPath,
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes/origin",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (refs.status !== 0)
    throw new CapError(
      `Could not enumerate authoritative refs: ${refs.stderr.trim()}`,
      "FORGEJO_MIRROR_FAILED",
    );
  const branchRefspecs = refs.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value && value !== "refs/remotes/origin/HEAD")
    .map(
      (value) =>
        `${value}:refs/heads/${value.slice("refs/remotes/origin/".length)}`,
    );
  const commands = [
    ...(branchRefspecs.length === 0
      ? []
      : [["-C", project.repoPath, "push", remote, ...branchRefspecs]]),
    ["-C", project.repoPath, "push", remote, "--tags"],
  ];
  for (const args of commands) {
    const result = spawnSync("git", args, {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new CapError(
        `GitHub backup mirror '${remote}' failed: ${result.stderr.trim()}`,
        "FORGEJO_MIRROR_FAILED",
      );
  }
  const authority = spawnSync(
    "git",
    ["-C", project.repoPath, "rev-parse", `refs/remotes/origin/${project.baseBranch}`],
    { encoding: "utf8", windowsHide: true },
  );
  const backup = spawnSync(
    "git",
    ["-C", project.repoPath, "ls-remote", remote, `refs/heads/${project.baseBranch}`],
    { encoding: "utf8", windowsHide: true },
  );
  const authoritySha = authority.stdout.trim();
  const backupSha = backup.stdout.trim().split(/\s+/)[0] ?? "";
  if (
    authority.status !== 0 ||
    backup.status !== 0 ||
    authoritySha !== acceptedCommit ||
    backupSha !== acceptedCommit
  )
    throw new CapError(
      `GitHub backup mirror '${remote}' did not verify accepted commit ${acceptedCommit}`,
      "FORGEJO_MIRROR_VERIFY_FAILED",
    );
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

export function forgejoInstallSummary(
  home: AcceptanceHomePaths,
  config: ForgejoProviderConfig,
): Record<string, unknown> {
  const secret = forgejoSecretPath(home, config.credentialRef);
  return {
    server_url: config.serverUrl,
    repository: `${config.owner}/${config.repo}`,
    status_context: config.statusContext,
    credential_file: basename(secret),
    credential_present: existsSync(secret),
  };
}
