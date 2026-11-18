import { createSignal, onCleanup } from "solid-js"
import { ComposerPill, createKeyed, Plugin } from "@opencode/plugin/gui"
import { Metrics, type MetricsValue } from "./rpc.js"

// A step can stay "streaming" forever when a turn is interrupted without an
// end event. Treat it as idle once nothing has arrived for this long.
const STREAM_IDLE_MS = 45_000
const CLOCK_INTERVAL_MS = 1_000

const formatDuration = (milliseconds: number | undefined) => {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return undefined
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1000).toFixed(2)}s`
}

const formatRate = (tokensPerSecond: number | undefined) => {
  if (tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond)) return undefined
  return `${tokensPerSecond.toFixed(tokensPerSecond >= 100 ? 0 : 1)} tok/s`
}

const formatPercent = (rate: number | undefined) => {
  if (rate === undefined || !Number.isFinite(rate)) return undefined
  return `${(rate * 100).toFixed(1)}%`
}

const formatModel = (metrics: MetricsValue) => {
  const id = `${metrics.model.providerID}/${metrics.model.modelID}`
  return metrics.model.variant ? `${id}#${metrics.model.variant}` : id
}

const isStreaming = (metric: MetricsValue, now: number) => {
  if (metric.status !== "streaming" || metric.completedAt !== undefined) return false
  const lastActivity = metric.startedAt + (metric.generationMs ?? 0)
  return now - lastActivity < STREAM_IDLE_MS
}

// One source of truth for the word and the number, so the pill can never say
// "实时" while showing a finished turn.
const speedOf = (metric: MetricsValue, now: number) => {
  if (isStreaming(metric, now)) return { label: "实时", value: metric.liveOutputTokensPerSecond }
  if (metric.averageOutputTokensPerSecond !== undefined) {
    return { label: "平均", value: metric.averageOutputTokensPerSecond }
  }
  if (metric.outputTokensPerSecond !== undefined) {
    return { label: "上次", value: metric.outputTokensPerSecond }
  }
  return { label: "速度", value: undefined }
}

// First byte is the honest network number; time to first token falls back in
// when the provider path never reports a first byte (proxy, WebSocket, retry).
const latencyOf = (metric: MetricsValue, now: number) => {
  const streaming = isStreaming(metric, now)
  const network = streaming
    ? metric.networkFirstByteMs
    : (metric.averageNetworkFirstByteMs ?? metric.networkFirstByteMs)
  if (network !== undefined) return { label: "首包", value: network }

  const firstToken = streaming
    ? metric.firstTokenMs
    : (metric.averageFirstTokenMs ?? metric.firstTokenMs)
  if (firstToken !== undefined) return { label: "到达", value: firstToken }

  return { label: "首包", value: undefined }
}

const cacheOf = (metric: MetricsValue) => metric.sessionCacheHitRate ?? metric.cacheHitRate

export default Plugin.define({
  setup(ctx) {
    const [metricsBySession, setMetricsBySession] = createSignal<Record<string, MetricsValue>>({})
    const [clock, setClock] = createSignal(Date.now())

    const timer = setInterval(() => setClock(Date.now()), CLOCK_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))

    const remember = (metric: MetricsValue) => {
      setMetricsBySession((previous) => ({ ...previous, [metric.sessionID]: metric }))
    }

    createKeyed(
      () => ctx.client,
      (client) => {
        const rpc = client.rpc(Metrics)
        const unsubscribe = rpc.events.on("updated", (event) => {
          const metric = event.data.metrics as MetricsValue
          remember(metric)
        })
        onCleanup(unsubscribe)

        const session = ctx.sessions.current()
        if (session) {
          void rpc
            .get({ sessionID: session.id })
            .then((result) => {
              const snapshot = result as { metrics?: MetricsValue | null }
              if (!snapshot.metrics) return
              remember(snapshot.metrics)
            })
            .catch(() => undefined)
        }
      },
    )

    createKeyed(
      () => ctx.sessions.current()?.id,
      (sessionID) => {
        if (!sessionID) return
        void ctx.client
          .rpc(Metrics)
          .get({ sessionID })
          .then((result) => {
            const snapshot = result as { metrics?: MetricsValue | null }
            if (!snapshot.metrics) return
            remember(snapshot.metrics)
          })
          .catch(() => undefined)
      },
    )

    ctx.add(ComposerPill, {
      id: "metrics",
      order: 90,
      show: ({ session }) => {
        const now = clock()
        const metric = metricsBySession()[session.id]

        if (!metric) {
          return {
            label: "速度 — · 首包 — · 缓存 —",
            title: "当前会话还没有可用的指标",
            rows: [
              {
                id: "waiting",
                label: "等待模型指标",
                detail: "发送消息后显示速度、首包延迟和缓存命中率",
              },
            ],
          }
        }

        const streaming = isStreaming(metric, now)
        const speed = speedOf(metric, now)
        const latency = latencyOf(metric, now)
        const cache = cacheOf(metric)

        const speedText =
          speed.value !== undefined
            ? `${speed.label} ${formatRate(speed.value)}`
            : streaming
              ? "等待首字"
              : "速度 —"
        const latencyText = `${latency.label} ${formatDuration(latency.value) ?? "—"}`
        const cacheText = `缓存 ${formatPercent(cache) ?? "—"}`

        return {
          label: [speedText, latencyText, cacheText].join(" · "),
          title: [
            `实时 ${formatRate(streaming ? metric.liveOutputTokensPerSecond : undefined) ?? "—"}`,
            `平均 ${formatRate(metric.averageOutputTokensPerSecond) ?? "—"}`,
            `${latency.label} ${formatDuration(latency.value) ?? "—"}`,
            cacheText,
            formatModel(metric),
          ].join(" · "),
          rows: [
            {
              id: "speed",
              label: `${speed.label} ${formatRate(speed.value) ?? "—"}`,
              detail: [
                `平均 ${formatRate(metric.averageOutputTokensPerSecond) ?? "—"}`,
                `上次 ${formatRate(metric.outputTokensPerSecond) ?? "—"}`,
                `含思考 ${formatDuration(metric.generationMs) ?? "—"}`,
              ].join(" · "),
            },
            {
              id: "latency",
              label: latencyText,
              detail: [
                `上次首包 ${formatDuration(metric.networkFirstByteMs) ?? "—"}`,
                `平均首包 ${formatDuration(metric.averageNetworkFirstByteMs) ?? "—"}`,
                `首字 ${formatDuration(metric.firstTokenMs) ?? "—"}`,
              ].join(" · "),
            },
            {
              id: "cache",
              label: cacheText,
              detail: [
                `输入 ${metric.inputTokens ?? "—"}`,
                `缓存读 ${metric.cacheReadTokens ?? "—"}`,
                `已完成 ${metric.completedSteps ?? 0} 步`,
              ].join(" · "),
            },
            {
              id: "model",
              label: formatModel(metric),
              detail: `状态 ${metric.status}`,
            },
          ],
        }
      },
    })
  },
})
