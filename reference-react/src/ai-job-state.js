export function buildLiveAgentStates(agentJob, selectedAgentNames = []) {
  if (agentJob?.agentStates?.length) return agentJob.agentStates;
  return selectedAgentNames.map((teacherName) => ({ teacherName, status: "waiting" }));
}

export function deriveAgentProgress(agentJob, selectedAgentNames = []) {
  const liveAgentStates = buildLiveAgentStates(agentJob, selectedAgentNames);
  const independentCompletedCount = liveAgentStates.filter((item) => item.status === "completed").length;
  const independentFailureCount = liveAgentStates.filter((item) => item.status === "failed").length;
  return {
    liveAgentStates,
    liveAgentTotal: liveAgentStates.length || selectedAgentNames.length,
    independentCompletedCount,
    independentFailureCount,
  };
}

export function shouldKeepAgentJob(agentJob) {
  return agentJob?.status === "failed" || agentJob?.pollingState === "deadline_exceeded";
}

export function shouldShowAgentRunStatus({ sending, agentJob }) {
  return Boolean(sending || shouldKeepAgentJob(agentJob) || (agentJob?.incremental && agentJob.status !== "completed"));
}

export function deriveSummaryState({ summaryStatus, fallbackMode, failedAgents = 0 }) {
  const coordinatorFallback = fallbackMode === "shared_model" || summaryStatus === "coordinator_fallback";
  const summaryTimedOut = summaryStatus === "summary_timeout";
  const summaryUnavailable = summaryStatus === "summary_unavailable";
  const partial = coordinatorFallback || failedAgents > 0 || summaryTimedOut || summaryUnavailable;
  return {
    coordinatorFallback,
    summaryTimedOut,
    summaryUnavailable,
    partial,
    label: coordinatorFallback
      ? "共享模型降级"
      : summaryTimedOut
        ? "综合超时"
        : summaryUnavailable
          ? "综合未生成"
          : failedAgents
            ? "部分完成"
            : "全部完成",
  };
}
