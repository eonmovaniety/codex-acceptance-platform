import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type {
  AcceptanceRun,
  AutomationJob,
  NotificationDelivery,
  NotificationOutboxItem,
  Project,
  ProjectConfig,
  RunTriggerSource,
} from "./domain.js";
import type { ArtifactStore } from "./artifacts.js";
import type { AcceptanceMatrix } from "./matrix.js";
import type { GateDecision } from "./gate.js";
import type { ReviewerReport } from "./review.js";
import type { VerifierResult } from "./verifier.js";
import type { AcceptanceHomePaths } from "./paths.js";
import { SqliteStore, systemClock, type Clock } from "./storage.js";

export const notificationChannels = [
  "terminal",
  "windows_toast",
  "ci_summary",
] as const;

export type NotificationChannel = (typeof notificationChannels)[number];

export interface AcceptanceSummary {
  version: 1;
  run_id: string;
  project_id: string;
  task_id: string;
  trigger_source: string;
  execution_scope: string;
  attempt: number;
  target_commit: string;
  status: string;
  decision?: string;
  gate?: {
    decision: string;
    reason_codes: string[];
    policy_version: string;
  };
  coverage: {
    total: number;
    pass: number;
    fail: number;
    not_tested: number;
    blocked: number;
    not_applicable: number;
    core_total: number;
    core_pass: number;
  };
  stage_results: Record<string, string>;
  findings: {
    total: number;
    ids: string[];
    human_requests: number;
  };
  not_tested: string[];
  evidence_refs: string[];
  next_action: string;
  started_at?: string;
  completed_at?: string;
  duration_seconds?: number;
  notification_deliveries: Record<string, string>;
}

export interface AcceptanceNotification {
  version: 1;
  id: string;
  event_type: string;
  run_id?: string;
  job_id?: string;
  channels: NotificationChannel[];
  summary?: AcceptanceSummary;
  message: string;
  created_at: string;
}

export interface DeliveryResult {
  status: "SENT" | "FAILED";
  error?: string;
}

export interface Notifier {
  readonly channel: NotificationChannel;
  send(event: AcceptanceNotification): Promise<DeliveryResult>;
}

export interface SummaryInput {
  run: AcceptanceRun;
  project: Project;
  matrix?: AcceptanceMatrix;
  gate?: GateDecision;
  verifierResults?: VerifierResult[];
  reviewerReport?: ReviewerReport;
  evidencePaths?: string[];
  nextAction?: string;
  notificationDeliveries?: Record<string, string>;
  now?: () => string;
}

export function buildAcceptanceSummary(input: SummaryInput): AcceptanceSummary {
  const matrix = input.matrix;
  const gate = input.gate;
  const verifierResults = input.verifierResults ?? [];
  const reviewerReport = input.reviewerReport;
  const coverage = matrix?.coverage ?? {
    total: 0,
    pass: 0,
    fail: 0,
    not_tested: 0,
    blocked: 0,
    not_applicable: 0,
  };
  const core =
    matrix?.requirements.filter(
      (requirement) => requirement.criticality === "core",
    ) ?? [];
  const stageResults: Record<string, string> = {};
  for (const result of verifierResults) {
    const current = stageResults[result.stage];
    if (current === "FAIL" || current === "BLOCKED") continue;
    stageResults[result.stage] = result.result;
  }
  const notTested = [
    ...Object.entries(stageResults)
      .filter(([, result]) => result === "NOT_TESTED")
      .map(([stage]) => `stage:${stage}`),
    ...(matrix?.requirements
      .filter((requirement) => requirement.result === "NOT_TESTED")
      .map((requirement) => `requirement:${requirement.id}`) ?? []),
  ].sort();
  const findings = reviewerReport?.findings ?? [];
  const startedAt = input.run.startedAt;
  const completedAt = input.run.completedAt;
  const durationSeconds =
    startedAt && completedAt
      ? Math.max(0, (Date.parse(completedAt) - Date.parse(startedAt)) / 1000)
      : undefined;
  const triggerSource = input.run.triggerSource ?? "manual";
  const executionScope = input.run.executionScope ?? "local";
  const decision = input.run.decision ?? gate?.decision;
  return {
    version: 1,
    run_id: input.run.id,
    project_id: input.project.id,
    task_id: input.run.taskId,
    trigger_source: triggerSource,
    execution_scope: executionScope,
    attempt: input.run.attempt ?? 1,
    target_commit: input.run.targetCommit,
    status: input.run.status,
    ...(decision === undefined ? {} : { decision }),
    ...(gate
      ? {
          gate: {
            decision: gate.decision,
            reason_codes: gate.reason_codes,
            policy_version: gate.policy_version,
          },
        }
      : {}),
    coverage: {
      ...coverage,
      core_total: core.length,
      core_pass: core.filter((requirement) => requirement.result === "PASS")
        .length,
    },
    stage_results: stageResults,
    findings: {
      total: findings.length,
      ids: findings.map((finding) => finding.id).sort(),
      human_requests: reviewerReport?.requested_human_decisions.length ?? 0,
    },
    not_tested: notTested,
    evidence_refs: [...new Set(input.evidencePaths ?? [])].sort(),
    next_action:
      input.nextAction ??
      nextActionFor(input.run.status, decision, executionScope),
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(completedAt === undefined ? {} : { completed_at: completedAt }),
    ...(durationSeconds === undefined
      ? {}
      : { duration_seconds: durationSeconds }),
    notification_deliveries: input.notificationDeliveries ?? {},
  };
}

export function renderSummaryMarkdown(summary: AcceptanceSummary): string {
  const stageLines = Object.entries(summary.stage_results)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stage, result]) => `| ${stage} | ${result} |`)
    .join("\n");
  const notTested =
    summary.not_tested.length === 0
      ? "None"
      : summary.not_tested.map((value) => `\`${value}\``).join(", ");
  const gate = summary.gate
    ? `${summary.gate.decision} (${summary.gate.reason_codes.join(", ")})`
    : "Not available";
  return [
    `# CAP Acceptance Summary: ${summary.project_id}`,
    "",
    `- Run: \`${summary.run_id}\``,
    `- Task: \`${summary.task_id}\``,
    `- Target commit: \`${summary.target_commit}\``,
    `- Trigger: \`${summary.trigger_source}\``,
    `- Scope: \`${summary.execution_scope}\``,
    `- Status: **${summary.status}**`,
    `- Gate: **${gate}**`,
    `- Core coverage: **${summary.coverage.core_pass}/${summary.coverage.core_total}**`,
    `- Total coverage: **${summary.coverage.pass}/${summary.coverage.total}**`,
    "",
    "## Verification stages",
    "",
    "| Stage | Result |",
    "| --- | --- |",
    stageLines || "| None | NOT_TESTED |",
    "",
    `## Not tested\n\n${notTested}`,
    "",
    `## Findings\n\n${summary.findings.total} finding(s); ${summary.findings.human_requests} human request(s).`,
    "",
    `## Next action\n\n${summary.next_action}`,
    "",
    `## Evidence\n\n${summary.evidence_refs.map((path) => `- \`${path}\``).join("\n") || "- None"}`,
    "",
  ].join("\n");
}

export function notificationChannelsFor(
  config: ProjectConfig,
  source: RunTriggerSource | undefined,
  eventType: string,
): NotificationChannel[] {
  const notificationConfig = config.automation?.notifications;
  const channels: NotificationChannel[] = [];
  const isCi = source === "ci_pull_request" || source === "ci_push";
  const terminalEnabled = notificationConfig?.terminal ?? true;
  const toastEnabled = notificationConfig?.windows_toast ?? true;
  const ciEnabled = notificationConfig?.ci_summary ?? true;
  if (eventType === "automation.enqueued") {
    if (terminalEnabled) channels.push("terminal");
  } else if (eventType === "automation.started") {
    if (terminalEnabled) channels.push("terminal");
  } else if (eventType === "automation.progress") {
    if (toastEnabled && !isCi) channels.push("windows_toast");
  } else if (eventType === "automation.blocked") {
    if (terminalEnabled) channels.push("terminal");
    if (toastEnabled && !isCi) channels.push("windows_toast");
    if (isCi && ciEnabled) channels.push("ci_summary");
  } else if (
    eventType === "automation.completed" ||
    eventType === "automation.failed" ||
    eventType === "automation.human_required"
  ) {
    if (terminalEnabled) channels.push("terminal");
    if (toastEnabled && !isCi) channels.push("windows_toast");
    if (isCi && ciEnabled) channels.push("ci_summary");
  }
  return [...new Set(channels)];
}

export function createNotificationOutbox(
  input: {
    eventType: string;
    runId?: string;
    jobId?: string;
    source?: RunTriggerSource;
    channels: NotificationChannel[];
    payload?: Record<string, unknown>;
    dedupeSuffix?: string;
    now?: () => string;
  },
  now = systemClock.now,
): NotificationOutboxItem {
  const identity = input.runId ?? input.jobId ?? randomUUID();
  const dedupeKey = `${identity}:${input.eventType}${
    input.dedupeSuffix ? `:${input.dedupeSuffix}` : ""
  }`;
  const createdAt = (input.now ?? now)();
  return {
    id: `NOTIFY-${randomUUID().slice(0, 8).toUpperCase()}`,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    eventType: input.eventType,
    dedupeKey,
    payload: {
      ...(input.payload ?? {}),
      ...(input.source === undefined ? {} : { source: input.source }),
      channels: input.channels,
    },
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: createdAt,
    createdAt,
  };
}

export class ConsoleNotifier implements Notifier {
  readonly channel = "terminal" as const;

  constructor(
    private readonly write: (message: string) => void = console.error,
  ) {}

  async send(event: AcceptanceNotification): Promise<DeliveryResult> {
    this.write(formatNotification(event));
    return { status: "SENT" };
  }
}

export class WindowsToastNotifier implements Notifier {
  readonly channel = "windows_toast" as const;

  constructor(
    private readonly runner: (
      title: string,
      body: string,
    ) => boolean = nativeWindowsToast,
  ) {}

  async send(event: AcceptanceNotification): Promise<DeliveryResult> {
    if (process.platform !== "win32")
      return {
        status: "FAILED",
        error: "Windows Toast is only available on Windows",
      };
    const summary = event.summary;
    const title = summary
      ? `[CAP][${summary.decision ?? summary.status}] ${summary.project_id}`
      : `[CAP] ${event.event_type}`;
    const body = trimToastBody(event.message);
    return this.runner(title, body)
      ? { status: "SENT" }
      : { status: "FAILED", error: "Windows Toast provider failed" };
  }
}

export class GitHubSummaryNotifier implements Notifier {
  readonly channel = "ci_summary" as const;

  constructor(
    private readonly summaryPath: string | undefined = process.env
      .GITHUB_STEP_SUMMARY,
  ) {}

  async send(event: AcceptanceNotification): Promise<DeliveryResult> {
    if (!this.summaryPath)
      return { status: "FAILED", error: "GITHUB_STEP_SUMMARY is not set" };
    appendFileSync(this.summaryPath, `${event.message}\n`, "utf8");
    return { status: "SENT" };
  }
}

export interface NotificationDispatcherDependencies {
  store: SqliteStore;
  artifacts: ArtifactStore;
  home: AcceptanceHomePaths;
  notifiers?: Notifier[];
  clock?: Clock;
}

export class NotificationDispatcher {
  private readonly clock: Clock;
  private readonly notifiers: Map<NotificationChannel, Notifier>;

  constructor(
    private readonly dependencies: NotificationDispatcherDependencies,
  ) {
    this.clock = dependencies.clock ?? systemClock;
    this.notifiers = new Map(
      (
        dependencies.notifiers ?? [
          new ConsoleNotifier(),
          new WindowsToastNotifier(),
          new GitHubSummaryNotifier(),
        ]
      ).map((notifier) => [notifier.channel, notifier]),
    );
  }

  async dispatchPending(): Promise<void> {
    const items = this.dependencies.store.listNotificationOutbox([
      "PENDING",
      "FAILED",
      "SENDING",
    ]);
    for (const item of items) {
      if (Date.parse(item.nextAttemptAt) > Date.parse(this.clock.now()))
        continue;
      await this.dispatch(item);
    }
  }

  async dispatch(item: NotificationOutboxItem): Promise<void> {
    const current = this.dependencies.store.getNotificationOutbox(item.id);
    const { lastError: _lastError, ...withoutLastError } = current;
    const started: NotificationOutboxItem = {
      ...withoutLastError,
      status: "SENDING",
      attempts: current.attempts + 1,
    };
    this.dependencies.store.updateNotificationOutbox(started);
    let event: AcceptanceNotification;
    try {
      event = this.buildEvent(started);
    } catch (error) {
      this.dependencies.store.updateNotificationOutbox({
        ...started,
        status: "FAILED",
        lastError: error instanceof Error ? error.message : String(error),
        nextAttemptAt: retryAt(started.attempts, this.clock.now()),
      });
      return;
    }
    const channels = parseChannels(started.payload.channels);
    let failed = false;
    for (const channel of channels) {
      const notifier = this.notifiers.get(channel);
      if (!notifier) {
        const now = this.clock.now();
        const existing = this.dependencies.store.findNotificationDelivery(
          started.id,
          channel,
        );
        const unavailable: NotificationDelivery = existing
          ? {
              ...existing,
              status: "FAILED",
              attempts: existing.attempts + 1,
              lastError: `No notifier is registered for channel '${channel}'`,
              nextAttemptAt: retryAt(existing.attempts + 1, now),
            }
          : {
              id: `DELIVERY-${randomUUID().slice(0, 8).toUpperCase()}`,
              outboxId: started.id,
              channel,
              status: "FAILED",
              attempts: 1,
              nextAttemptAt: retryAt(1, now),
              lastError: `No notifier is registered for channel '${channel}'`,
              createdAt: now,
            };
        if (existing)
          this.dependencies.store.updateNotificationDelivery(unavailable);
        else this.dependencies.store.createNotificationDelivery(unavailable);
        failed = true;
        continue;
      }
      let delivery = this.dependencies.store.findNotificationDelivery(
        started.id,
        channel,
      );
      if (!delivery) {
        delivery = this.dependencies.store.createNotificationDelivery({
          id: `DELIVERY-${randomUUID().slice(0, 8).toUpperCase()}`,
          outboxId: started.id,
          channel,
          status: "PENDING",
          attempts: 0,
          nextAttemptAt: this.clock.now(),
          createdAt: this.clock.now(),
        });
      }
      if (delivery.status === "SENT") continue;
      const { lastError: _deliveryLastError, ...deliveryWithoutLastError } =
        delivery;
      const sending: NotificationDelivery = {
        ...deliveryWithoutLastError,
        status: "SENDING",
        attempts: delivery.attempts + 1,
      };
      this.dependencies.store.updateNotificationDelivery(sending);
      let result: DeliveryResult;
      try {
        result = await notifier.send(event);
      } catch (error) {
        result = {
          status: "FAILED",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.status === "SENT") {
        this.dependencies.store.updateNotificationDelivery({
          ...sending,
          status: "SENT",
          sentAt: this.clock.now(),
          nextAttemptAt: this.clock.now(),
        });
      } else {
        failed = true;
        this.dependencies.store.updateNotificationDelivery({
          ...sending,
          status: "FAILED",
          lastError: result.error ?? "Notification failed",
          nextAttemptAt: retryAt(sending.attempts, this.clock.now()),
        });
      }
    }
    if (failed) {
      this.dependencies.store.updateNotificationOutbox({
        ...started,
        status: "FAILED",
        lastError: "One or more notification channels failed",
        nextAttemptAt: retryAt(started.attempts, this.clock.now()),
      });
    } else {
      this.dependencies.store.updateNotificationOutbox({
        ...started,
        status: "SENT",
        sentAt: this.clock.now(),
        nextAttemptAt: this.clock.now(),
      });
    }
  }

  private buildEvent(item: NotificationOutboxItem): AcceptanceNotification {
    const summary = item.runId ? this.readSummary(item.runId) : undefined;
    const message = summary
      ? formatNotification({
          version: 1,
          id: item.id,
          event_type: item.eventType,
          ...(item.runId === undefined ? {} : { run_id: item.runId }),
          ...(item.jobId === undefined ? {} : { job_id: item.jobId }),
          channels: parseChannels(item.payload.channels),
          summary,
          message: "",
          created_at: item.createdAt,
        })
      : renderQueuedMessage(item);
    return {
      version: 1,
      id: item.id,
      event_type: item.eventType,
      ...(item.runId === undefined ? {} : { run_id: item.runId }),
      ...(item.jobId === undefined ? {} : { job_id: item.jobId }),
      channels: parseChannels(item.payload.channels),
      ...(summary === undefined ? {} : { summary }),
      message,
      created_at: item.createdAt,
    };
  }

  private readSummary(runId: string): AcceptanceSummary | undefined {
    const run = this.dependencies.store.getRun(runId);
    if (
      !this.dependencies.artifacts.exists(
        run.projectId,
        run.taskId,
        run.id,
        "acceptance/summary.json",
      )
    )
      return undefined;
    return JSON.parse(
      this.dependencies.artifacts.readText(
        run.projectId,
        run.taskId,
        run.id,
        "acceptance/summary.json",
      ),
    ) as AcceptanceSummary;
  }
}

export function formatNotification(event: AcceptanceNotification): string {
  const summary = event.summary;
  if (!summary) return redactText(event.message);
  const gate = summary.gate
    ? `${summary.gate.decision} (${summary.gate.reason_codes.join(", ")})`
    : "N/A";
  const stages = Object.entries(summary.stage_results)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stage, result]) => `${stage}=${result}`)
    .join(", ");
  const notTested =
    summary.not_tested.length > 0
      ? `\n未测试: ${summary.not_tested.join(", ")}`
      : "";
  const duration =
    summary.duration_seconds === undefined
      ? ""
      : `耗时: ${summary.duration_seconds}s`;
  const findings =
    summary.findings.ids.length > 0
      ? `主要失败项: ${summary.findings.ids.join(", ")}`
      : "主要失败项: none";
  return redactText(
    [
      `[CAP][${summary.decision ?? summary.status}] ${summary.project_id}`,
      `Run: ${summary.run_id}`,
      `Commit: ${summary.target_commit.slice(0, 12)}`,
      `触发: ${summary.trigger_source}; 范围: ${summary.execution_scope}`,
      `状态: ${summary.status}; Gate: ${gate}`,
      `核心需求: ${summary.coverage.core_pass}/${summary.coverage.core_total}; 总覆盖: ${summary.coverage.pass}/${summary.coverage.total}`,
      `阶段: ${stages || "NOT_TESTED"}`,
      `发现: ${summary.findings.total}; ${findings}; 人工请求: ${summary.findings.human_requests}`,
      duration,
      notTested,
      `下一步: ${summary.next_action}`,
      `证据: ${summary.evidence_refs.join(", ") || "none"}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function renderBlockedMessage(item: NotificationOutboxItem): string {
  const reason =
    stringValue(item.payload.reason) ?? "automation job is blocked";
  return redactText(
    [
      `[CAP][BLOCKED] 自动验收未执行`,
      `Job: ${item.jobId ?? "unknown"}`,
      `原因: ${reason}`,
      `下一步: 修复阻塞条件后重新提交或重新触发。`,
    ].join("\n"),
  );
}

function renderQueuedMessage(item: NotificationOutboxItem): string {
  const source = stringValue(item.payload.source) ?? "unknown";
  const targetCommit = stringValue(item.payload.target_commit);
  const elapsed = stringOrNumber(item.payload.elapsed_seconds);
  const stage = stringValue(item.payload.stage);
  const reason = stringValue(item.payload.reason);
  if (item.eventType === "automation.blocked")
    return renderBlockedMessage(item);
  if (item.eventType === "automation.progress")
    return redactText(
      [
        `[CAP][PROGRESS] 自动验收仍在运行`,
        `Run: ${item.runId ?? "unknown"}`,
        `触发: ${source}`,
        stage ? `阶段: ${stage}` : "",
        elapsed ? `耗时: ${elapsed}s` : "",
        reason ? `说明: ${reason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  if (item.eventType === "automation.started")
    return redactText(
      [
        `[CAP][STARTED] 自动验收已开始`,
        `Run: ${item.runId ?? "unknown"}`,
        `Commit: ${targetCommit?.slice(0, 12) ?? "unknown"}`,
        `触发: ${source}`,
      ].join("\n"),
    );
  return redactText(
    [
      `[CAP][ENQUEUED] 自动验收已入队`,
      `Job: ${item.jobId ?? "unknown"}`,
      `Run: ${item.runId ?? "unknown"}`,
      `Commit: ${targetCommit?.slice(0, 12) ?? "unknown"}`,
      `触发: ${source}`,
    ].join("\n"),
  );
}

function nextActionFor(
  status: string,
  decision: string | undefined,
  executionScope: string,
): string {
  if (status === "INFRA_FAILED")
    return "检查 run/error.json；基础设施失败可由自动化重试。";
  if (decision === "PASS")
    return executionScope === "ci"
      ? "无需处理；CI Gate 是正式合并结论。"
      : "等待 CI 权威 Gate；本地 PASS 仅作快速反馈。";
  if (decision === "FAIL")
    return "根据 Failure Package 创建修复提交并重新验收。";
  if (decision === "HUMAN") return "查看 Human 请求并完成明确的人工决策。";
  return "检查 Run 状态和错误证据。";
}

function parseChannels(value: unknown): NotificationChannel[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (candidate): candidate is NotificationChannel =>
      typeof candidate === "string" &&
      (notificationChannels as readonly string[]).includes(candidate),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOrNumber(value: unknown): string | undefined {
  return typeof value === "number" || typeof value === "string"
    ? String(value)
    : undefined;
}

function retryAt(attempts: number, now: string): string {
  const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
  return new Date(Date.parse(now) + delaySeconds * 1000).toISOString();
}

function trimToastBody(value: string): string {
  const normalized = value.replaceAll("\r", "").replaceAll("\n", " | ");
  return normalized.length > 240
    ? `${normalized.slice(0, 237)}...`
    : normalized;
}

function redactText(value: string): string {
  return value
    .replace(
      /((?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED_SECRET]",
    )
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
      "[REDACTED_KEY]",
    );
}

function nativeWindowsToast(title: string, body: string): boolean {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
    "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)",
    "$texts = $xml.GetElementsByTagName('text')",
    "$null = $texts.Item(0).AppendChild($xml.CreateTextNode($env:CAP_TOAST_TITLE))",
    "$null = $texts.Item(1).AppendChild($xml.CreateTextNode($env:CAP_TOAST_BODY))",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Windows PowerShell').Show($toast)",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      env: {
        ...process.env,
        CAP_TOAST_TITLE: trimToastBody(title),
        CAP_TOAST_BODY: trimToastBody(body),
      },
    },
  );
  return result.status === 0;
}
