import { Plugin } from "@opencode/plugin"
import { Metrics, type MetricsValue } from "./rpc.js"

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const modelRef = (value: unknown): MetricsValue["model"] | undefined => {
  if (!isRecord(value)) return undefined
  const providerID = text(value.providerID)
  const modelID = text(value.modelID) ?? text(value.id)
  if (!providerID || !modelID) return undefined
  const variant = text(value.variant)
  return variant ? { providerID, modelID, variant } : { providerID, modelID }
}

const cacheRate = (inputTokens: number | undefined, cacheReadTokens: number | undefined) => {
  if (inputTokens === undefined || cacheReadTokens === undefined) return undefined
  const promptTokens = inputTokens + cacheReadTokens
  return promptTokens > 0 ? cacheReadTokens / promptTokens : undefined
}

export default Plugin.define({
  id: "opencode-v2-metrics",
  async setup(ctx) {
    const latest = new Map<string, MetricsValue>()
    const steps = new Map<string, MetricsValue>()
    const rpc = await ctx.rpc.register(Metrics, {
      get: async (input) => ({
        metrics: latest.get((input as { sessionID: string }).sessionID) ?? null,
      }),
    })

    const emit = (metrics: MetricsValue) => {
      latest.set(metrics.sessionID, metrics)
      void rpc.events.emit("updated", { metrics })
    }

    const trimLatest = () => {
      while (latest.size > 300) {
        const first = latest.keys().next().value
        if (first === undefined) return
        latest.delete(first)
      }
    }

    const controller = new AbortController()
    void (async () => {
      for await (const rawEvent of ctx.event.subscribe({ signal: controller.signal })) {
        const event = rawEvent as UnknownRecord
        const eventType = text(event.type)
        const data = isRecord(event.data) ? event.data : undefined
        if (!eventType || !data) continue

        if (eventType === "session.step.started") {
          const sessionID = text(data.sessionID)
          const assistantMessageID = text(data.assistantMessageID)
          const model = modelRef(data.model)
          const startedAt = number(data.started) ?? number(event.created) ?? Date.now()
          if (!sessionID || !assistantMessageID || !model) continue

          const metrics: MetricsValue = {
            sessionID,
            assistantMessageID,
            status: "streaming",
            model,
            startedAt,
          }
          steps.set(`${sessionID}:${assistantMessageID}`, metrics)
          emit(metrics)
          continue
        }

        if (eventType === "session.text.started") {
          const sessionID = text(data.sessionID)
          const assistantMessageID = text(data.assistantMessageID)
          if (!sessionID || !assistantMessageID) continue

          const key = `${sessionID}:${assistantMessageID}`
          const metrics = steps.get(key)
          if (!metrics || metrics.firstTextAt !== undefined) continue

          const firstTextAt = number(event.created) ?? Date.now()
          metrics.firstTextAt = firstTextAt
          metrics.firstTokenMs = Math.max(0, firstTextAt - metrics.startedAt)
          emit({ ...metrics })
          continue
        }

        if (eventType === "session.step.ended" || eventType === "session.step.failed") {
          const sessionID = text(data.sessionID)
          const assistantMessageID = text(data.assistantMessageID)
          if (!sessionID || !assistantMessageID) continue

          const key = `${sessionID}:${assistantMessageID}`
          const previous = steps.get(key)
          const model = previous?.model ?? modelRef(data.model)
          if (!previous || !model) continue

          const tokens = isRecord(data.tokens) ? data.tokens : undefined
          const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined
          const completedAt = number(event.created) ?? Date.now()
          const outputTokens = tokens ? number(tokens.output) : undefined
          const inputTokens = tokens ? number(tokens.input) : undefined
          const reasoningTokens = tokens ? number(tokens.reasoning) : undefined
          const cacheReadTokens = cache ? number(cache.read) : undefined
          const cacheWriteTokens = cache ? number(cache.write) : undefined
          const firstTextAt = previous.firstTextAt
          const durationStart = firstTextAt ?? previous.startedAt
          const seconds = Math.max(0, completedAt - durationStart) / 1000

          const metrics: MetricsValue = {
            ...previous,
            status: eventType === "session.step.failed" ? "error" : "completed",
            completedAt,
            outputTokens,
            inputTokens,
            reasoningTokens,
            cacheReadTokens,
            cacheWriteTokens,
            cacheHitRate: cacheRate(inputTokens, cacheReadTokens),
            outputTokensPerSecond:
              outputTokens !== undefined && outputTokens > 0 && seconds > 0
                ? outputTokens / seconds
                : undefined,
            finish: text(data.finish),
            error: isRecord(data.error) ? text(data.error.message) : undefined,
          }
          steps.delete(key)
          emit(metrics)
          trimLatest()
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("opencode-v2-metrics event loop failed", error)
    })

    return () => {
      controller.abort()
      void rpc.dispose()
    }
  },
})
