import { For, Show, createSignal, onCleanup } from "solid-js"
import { createKeyed, Plugin, Slot, Style } from "@opencode/plugin/gui"
import { Metrics, type MetricsValue } from "./rpc.js"

const formatDuration = (milliseconds: number | undefined) => {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "—"
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1000).toFixed(2)} s`
}

const formatRate = (tokensPerSecond: number | undefined) =>
  tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond)
    ? "—"
    : `${tokensPerSecond.toFixed(tokensPerSecond >= 100 ? 0 : 1)} tok/s`

const formatPercent = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`

const formatModel = (metrics: MetricsValue) => {
  const id = `${metrics.model.providerID}/${metrics.model.modelID}`
  return metrics.model.variant ? `${id}#${metrics.model.variant}` : id
}

export default Plugin.define({
  setup(ctx) {
    const [metricsBySession, setMetricsBySession] = createSignal<Record<string, MetricsValue>>({})

    ctx.add(
      Style,
      `
        .opencode-v2-metrics-bar {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 14px;
          min-width: 0;
          margin-left: 12px;
          padding: 0 8px;
          color: color-mix(in srgb, currentColor 72%, transparent);
          font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: nowrap;
          overflow: hidden;
        }

        .opencode-v2-metrics-bar[data-status="streaming"] {
          color: color-mix(in srgb, currentColor 88%, transparent);
        }

        .opencode-v2-metrics-item {
          display: inline-flex;
          align-items: baseline;
          gap: 5px;
        }

        .opencode-v2-metrics-label {
          opacity: 0.65;
        }

        .opencode-v2-metrics-value {
          color: currentColor;
          font-weight: 600;
        }

        .opencode-v2-metrics-model {
          max-width: 260px;
          overflow: hidden;
          text-overflow: ellipsis;
          opacity: 0.55;
        }

        @media (max-width: 720px) {
          .opencode-v2-metrics-bar { gap: 8px; font-size: 10px; }
          .opencode-v2-metrics-model { display: none; }
        }
      `,
    )

    createKeyed(
      () => ctx.client,
      (client) => {
        const rpc = client.rpc(Metrics)
        const unsubscribe = rpc.events.on("updated", (event) => {
          const metric = event.data.metrics as MetricsValue
          setMetricsBySession((previous) => ({ ...previous, [metric.sessionID]: metric }))
        })
        onCleanup(unsubscribe)

        const session = ctx.sessions.current()
        if (session) {
          void rpc.get({ sessionID: session.id }).then((result) => {
            const snapshot = result as { metrics?: MetricsValue | null }
            if (!snapshot.metrics) return
            const metric = snapshot.metrics
            setMetricsBySession((previous) => ({ ...previous, [metric.sessionID]: metric }))
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
          setMetricsBySession((previous) => ({ ...previous, [metric.sessionID]: metric }))
        })
      },
    )

    ctx.add(Slot, {
      at: "session.header",
      order: 90,
      render: ({ session }) => {
        const metric = session ? metricsBySession()[session.id] : undefined
        return (
          <Show when={metric}>
            {(current) => (
              <div
                class="opencode-v2-metrics-bar"
                data-status={current().status}
                title={formatModel(current())}
              >
                <span class="opencode-v2-metrics-item">
                  <span class="opencode-v2-metrics-label">速度</span>
                  <span class="opencode-v2-metrics-value">
                    {formatRate(current().outputTokensPerSecond)}
                  </span>
                </span>
                <span class="opencode-v2-metrics-item">
                  <span class="opencode-v2-metrics-label">首字</span>
                  <span class="opencode-v2-metrics-value">
                    {formatDuration(current().firstTokenMs)}
                  </span>
                </span>
                <span class="opencode-v2-metrics-item">
                  <span class="opencode-v2-metrics-label">缓存</span>
                  <span class="opencode-v2-metrics-value">
                    {formatPercent(current().cacheHitRate)}
                  </span>
                </span>
                <span class="opencode-v2-metrics-model">{formatModel(current())}</span>
              </div>
            )}
          </Show>
        )
      },
    })
  },
})
