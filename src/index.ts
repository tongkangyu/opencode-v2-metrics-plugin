import { Plugin } from "@opencode/plugin"
import { Metrics, type MetricsValue } from "./rpc.js"

type UnknownRecord = Record<string, unknown>

type ActiveStep = {
  metrics: MetricsValue
  textChars: number
}

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

const metricLike = (value: unknown): value is MetricsValue => {
  if (!isRecord(value)) return false
  return (
    typeof value.sessionID === "string" &&
    typeof value.assistantMessageID === "string" &&
    typeof value.startedAt === "number" &&
    modelRef(value.model) !== undefined
  )
}

export default Plugin.define({
  id: "opencode-v2-metrics",
  async setup(ctx) {
    const latest = new Map<string, MetricsValue>()
    const steps = new Map<string, ActiveStep>()
    const stored = await ctx.storage.get("last-settled")
    let lastSettled = metricLike(stored) ? stored : undefined
    let charsPerToken = 4

    const rpc = await ctx.rpc.register(Metrics, {
      get: async (input) => {
        const sessionID = (input as { sessionID: string }).sessionID
        const metric = latest.get(sessionID) ??
          (lastSettled ? { ...lastSettled, sessionID } : null)
        return { metrics: metric }
      },
    })

    const persistSettled = (metrics: MetricsValue) => {
      lastSettled = metrics
      void ctx.storage.set("last-settled", JSON.parse(JSON.stringify(metrics)))
    }

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

          const inherited = latest.get(sessionID) ?? lastSettled
          const metrics: MetricsValue = {
            sessionID,
            assistantMessageID,
            status: "streaming",
            model,
            startedAt,
            outputTokensPerSecond: inherited?.outputTokensPerSecond,
            cacheHitRate: inherited?.cacheHitRate,
            cacheStale: inherited?.cacheHitRate !== undefined,
          }
          steps.set(`${sessionID}:${assistantMessageID}`, { metrics, textChars: 0 })
          emit(metrics)
          continue
        }

        if (eventType === "session.text.started") {
          const sessionID = text(data.sessionID)
          const assistantMessageID = text(data.assistantMessageID)
          if (!sessionID || !assistantMessageID) continue

          const step = steps.get(`${sessionID}:${assistantMessageID}`)
          if (!step) continue

          const firstTextAt = number(event.created) ?? Date.now()
          if (step.metrics.firstTextAt === undefined) {
            step.metrics.firstTextAt = firstTextAt
            step.metrics.firstTokenMs = Math.max(0, firstTextAt - step.metrics.startedAt)
          }
          emit({ ...step.metrics })
          continue
        }

        if (eventType === "session.text.delta") {
          const sessionID = text(data.sessionID)
          const assistantMessageID = text(data.assistantMessageID)
          const delta = typeof data.delta === "string" ? data.delta : ""
          if (!sessionID || !assistantMessageID || delta.length === 0) continue

          const step = steps.get(`${sessionID}:${assistantMessageID}`)
          if (!step) continue

          const now = number(event.created) ?? Date.now()
          if (step.metrics.firstTextAt === undefined) {
            step.metrics.firstTextAt = now
            step.metrics.firstTokenMs = Math.max(0, now - step.metrics.startedAt)
          }

          step.textChars += delta.length
          const seconds = Math.max(0.001, now - step.metrics.firstTextAt) / 1000
          const estimatedTokens = step.textChars / charsPerToken
          step.metrics.liveOutputTokensPerSecond = estimatedTokens / seconds
          step.metrics.rateEstimated = true
          emit({ ...step.metrics })
          continue
        }

        if (eventType === "session.step.ended" || eventType === "session.step.failed") {
          const sessionID = text(data.sessionID)
          const assistantMessageID = text(data.assistantMessageID)
          if (!sessionID || !assistantMessageID) continue

          const key = `${sessionID}:${assistantMessageID}`
          const step = steps.get(key)
          if (!step) continue

          const previous = step.metrics
          const tokens = isRecord(data.tokens) ? data.tokens : undefined
          const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined
          const completedAt = number(event.created) ?? Date.now()
          const outputTokens = tokens ? number(tokens.output) : undefined
          const inputTokens = tokens ? number(tokens.input) : undefined
          const reasoningTokens = tokens ? number(tokens.reasoning) : undefined
          const cacheReadTokens = cache ? number(cache.read) : undefined
          const cacheWriteTokens = cache ? number(cache.write) : undefined
          const exactCacheRate = cacheRate(inputTokens, cacheReadTokens)
          const firstTextAt = previous.firstTextAt
          const durationStart = firstTextAt ?? previous.startedAt
          const seconds = Math.max(0, completedAt - durationStart) / 1000
          const estimatedRate =
            step.textChars > 0 && seconds > 0 ? step.textChars / charsPerToken / seconds : undefined
          const exactRate =
            outputTokens !== undefined && outputTokens > 0 && seconds > 0
              ? outputTokens / seconds
              : undefined

          if (exactRate !== undefined && step.textChars > 0 && outputTokens !== undefined) {
            charsPerToken = Math.min(8, Math.max(1, step.textChars / outputTokens))
          }

          const rate = exactRate ?? estimatedRate ?? previous.liveOutputTokensPerSecond ?? previous.outputTokensPerSecond
          const cacheHitRate = exactCacheRate ?? previous.cacheHitRate
          const metrics: MetricsValue = {
            ...previous,
            status: eventType === "session.step.failed" ? "error" : "completed",
            completedAt,
            outputTokens: outputTokens ?? previous.outputTokens,
            inputTokens: inputTokens ?? previous.inputTokens,
            reasoningTokens: reasoningTokens ?? previous.reasoningTokens,
            cacheReadTokens: cacheReadTokens ?? previous.cacheReadTokens,
            cacheWriteTokens: cacheWriteTokens ?? previous.cacheWriteTokens,
            cacheHitRate,
            cacheStale: exactCacheRate === undefined && cacheHitRate !== undefined,
            liveOutputTokensPerSecond: undefined,
            outputTokensPerSecond: rate,
            rateEstimated: exactRate === undefined,
            finish: text(data.finish),
            error: isRecord(data.error) ? text(data.error.message) : undefined,
          }

          steps.delete(key)
          if (metrics.status === "completed") persistSettled(metrics)
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
