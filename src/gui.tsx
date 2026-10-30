import { createSignal, onCleanup } from "solid-js"
import { ComposerPill, createKeyed, Plugin } from "@opencode/plugin/gui"
import { Metrics, type MetricsValue } from "./rpc.js"

const formatDuration = (milliseconds: number | undefined) => {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "—"
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1000).toFixed(2)}s`
}

const formatRate = (metric: MetricsValue) => {
  const tokensPerSecond = metric.liveOutputTokensPerSecond ?? metric.outputTokensPerSecond
  if (tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond)) return "—"
  return `${tokensPerSecond.toFixed(tokensPerSecond >= 100 ? 0 : 1)} tok/s`
}

const formatPercent = (metric: MetricsValue) => {
  if (metric.cacheHitRate === undefined || !Number.isFinite(metric.cacheHitRate)) return "—"
  return `${(metric.cacheHitRate * 100).toFixed(1)}%`
}

const formatModel = (metrics: MetricsValue) => {
  const id = `${metrics.model.providerID}/${metrics.model.modelID}`
  return metrics.model.variant ? `${id}#${metrics.model.variant}` : id
}

export default Plugin.define({
  setup(ctx) {
    const [metricsBySession, setMetricsBySession] = createSignal<Record<string, MetricsValue>>({})
    const [lastMetric, setLastMetric] = createSignal<MetricsValue | undefined>()

    const remember = (metric: MetricsValue) => {
      setMetricsBySession((previous) => ({ ...previous, [metric.sessionID]: metric }))
      setLastMetric(metric)
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
          void rpc.get({ sessionID: session.id }).then((result) => {
            const snapshot = result as { metrics?: MetricsValue | null }
            if (!snapshot.metrics) return
            const metric = snapshot.metrics
            remember(metric)
          })
        }
      },
    )

    createKeyed(
      () => ctx.sessions.current()?.id,
      (sessionID) => {
        if (!sessionID) return
        void ctx.client.rpc(Metrics).get({ sessionID }).then((result) => {
          const snapshot = result as { metrics?: MetricsValue | null }
          if (!snapshot.metrics) return
          const metric = snapshot.metrics
          remember(metric)
        })
      },
    )

    ctx.add(ComposerPill, {
      id: "metrics",
      order: 90,
      show: ({ session }) => {
        const metric = metricsBySession()[session.id] ?? lastMetric()
        if (!metric) {
          return {
            label: "— · — · —",
            title: "速度 — · 首字 — · 缓存 —",
          }
        }

        return {
          label: `${formatRate(metric)} · ${formatDuration(metric.firstTokenMs)} · ${formatPercent(metric)}`,
          title: `速度 ${formatRate(metric)} · 首字 ${formatDuration(metric.firstTokenMs)} · 缓存 ${formatPercent(metric)} · ${formatModel(metric)}`,
        }
      },
    })

  },
})
