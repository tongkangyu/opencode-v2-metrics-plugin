import { Plugin } from "@opencode/plugin"
import { Metrics, type MetricsValue } from "./rpc.js"

type UnknownRecord = Record<string, unknown>

type ActiveStep = {
  metrics: MetricsValue
  textChars: number
  reasoningChars: number
  networkStartedAt?: number
  streamStartedAt?: number
  lastDeltaAt?: number
}

type SessionStats = {
  generatedTokens: number
  wallMs: number
  completedSteps: number
  firstTokenMs: number
  firstTokenSteps: number
  networkFirstByteMs: number
  networkFirstByteSteps: number
  inputTokens: number
  cacheReadTokens: number
  cacheSamples: number
}

type NetworkTiming = {
  sessionID: string
  providerID?: string
  modelID?: string
  startedAt: number
  firstByteAt?: number
  attached?: boolean
}

const DEFAULT_CHARS_PER_TOKEN = 4
const MIN_CHARS_PER_TOKEN = 1
const MAX_CHARS_PER_TOKEN = 8
const MIN_RATE_SECONDS = 0.05
const EMIT_INTERVAL_MS = 100
const MAX_TRACKED = 300
const MAX_PENDING_NETWORK = 8

type SharedState = {
  latest: Map<string, MetricsValue>
  steps: Map<string, ActiveStep>
  sessionStats: Map<string, SessionStats>
  pendingNetwork: Map<string, NetworkTiming[]>
  processed: Set<string>
  charsPerToken: number
}

// A global plugin is instantiated once per location, but the HTTP hooks only
// fire in the instance that owns the session's directory while every instance
// sees the same event stream. Sharing one state object keeps the measurements
// where the hook can write them and lets any instance answer for any session.
const SHARED_KEY = Symbol.for("opencode-v2-metrics.shared")
const shared: SharedState = (() => {
  const store = globalThis as unknown as Record<symbol, SharedState | undefined>
  return (store[SHARED_KEY] ??= {
    latest: new Map(),
    steps: new Map(),
    sessionStats: new Map(),
    pendingNetwork: new Map(),
    processed: new Set(),
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
  })
})()

const rememberEvent = (id: string) => {
  shared.processed.add(id)
  if (shared.processed.size <= 4096) return
  let dropped = 0
  for (const key of shared.processed) {
    shared.processed.delete(key)
    if (++dropped >= 2048) break
  }
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

const emptyStats = (): SessionStats => ({
  generatedTokens: 0,
  wallMs: 0,
  completedSteps: 0,
  firstTokenMs: 0,
  firstTokenSteps: 0,
  networkFirstByteMs: 0,
  networkFirstByteSteps: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheSamples: 0,
})

// Tokens per second across every finished step. Wall clock on purpose: a model
// that thinks for ten seconds before answering is slower end to end, and that
// is part of what the average is meant to measure.
const averageRate = (stats: SessionStats | undefined) =>
  stats && stats.generatedTokens > 0 && stats.wallMs > 0
    ? stats.generatedTokens / (stats.wallMs / 1000)
    : undefined

const cleanMetric = (metrics: MetricsValue): MetricsValue =>
  JSON.parse(JSON.stringify(metrics)) as MetricsValue

export default Plugin.define({
  id: "opencode-v2-metrics",
  async setup(ctx) {
    const latest = shared.latest
    const steps = shared.steps
    const sessionStats = shared.sessionStats
    const pendingNetwork = shared.pendingNetwork
    const lastEmitAt = new Map<string, number>()
    const requestTimings = new WeakMap<Request, NetworkTiming>()

    // Remove the legacy cross-session snapshot from versions that persisted it.
    await ctx.storage.remove("last-settled")

    const rpc = await ctx.rpc.register(Metrics, {
      get: async (input) => {
        const sessionID = (input as { sessionID: string }).sessionID
        const metrics = latest.get(sessionID)
        return { metrics: metrics ? cleanMetric(metrics) : null }
      },
    })

    const emit = (metrics: MetricsValue, force = false) => {
      const now = Date.now()
      const previousEmit = lastEmitAt.get(metrics.sessionID) ?? 0
      if (!force && now - previousEmit < EMIT_INTERVAL_MS) return
      lastEmitAt.set(metrics.sessionID, now)
      const clean = cleanMetric(metrics)
      latest.set(clean.sessionID, clean)
      void rpc.events.emit("updated", { metrics: clean })
    }

    const trim = <T>(map: Map<string, T>) => {
      while (map.size > MAX_TRACKED) {
        const first = map.keys().next().value
        if (first === undefined) return
        map.delete(first)
      }
    }

    const sameModel = (metrics: MetricsValue, timing: NetworkTiming) =>
      metrics.sessionID === timing.sessionID &&
      (timing.providerID === undefined || timing.providerID === metrics.model.providerID) &&
      (timing.modelID === undefined || timing.modelID === metrics.model.modelID)

    // Several steps can share a model; always bind the timing to the newest one.
    // Falls back to the newest step in the same session when the provider
    // reports a model id that does not match the step's model ref.
    const findActiveStep = (timing: NetworkTiming) => {
      let exact: ActiveStep | undefined
      let newest: ActiveStep | undefined
      for (const step of steps.values()) {
        if (step.metrics.sessionID !== timing.sessionID) continue
        if (!newest || step.metrics.startedAt >= newest.metrics.startedAt) newest = step
        if (!sameModel(step.metrics, timing)) continue
        if (!exact || step.metrics.startedAt >= exact.metrics.startedAt) exact = step
      }
      return exact ?? newest
    }

    const applyNetworkFirstByte = (timing: NetworkTiming) => {
      if (timing.firstByteAt === undefined) return
      const step = findActiveStep(timing)
      if (!step) {
        return
      }
      step.networkStartedAt ??= timing.startedAt
      step.metrics.networkFirstByteMs = Math.max(0, timing.firstByteAt - step.networkStartedAt)
      emit({ ...step.metrics }, true)
    }

    const attachPendingNetwork = (timing: NetworkTiming) => {
      const step = findActiveStep(timing)
      if (step) {
        timing.attached = true
        step.networkStartedAt = timing.startedAt
        applyNetworkFirstByte(timing)
        return
      }
      const queue = pendingNetwork.get(timing.sessionID) ?? []
      queue.push(timing)
      while (queue.length > MAX_PENDING_NETWORK) queue.shift()
      pendingNetwork.set(timing.sessionID, queue)
    }

    // Live rate counts from the model call itself, so thinking time is part of
    // the number exactly like it is for the session average.
    const liveRate = (step: ActiveStep, now: number) => {
      const seconds = Math.max(MIN_RATE_SECONDS, (now - step.metrics.startedAt) / 1000)
      const tokens = (step.textChars + step.reasoningChars) / shared.charsPerToken
      return tokens > 0 ? tokens / seconds : undefined
    }

    const touchStream = (step: ActiveStep, now: number) => {
      step.streamStartedAt ??= now
      step.lastDeltaAt = now
      step.metrics.streamMs = Math.max(0, now - step.streamStartedAt)
    }

    await ctx.session.hook("http.request", (event) => {
      try {
        const sessionID = event.sessionID
        if (!sessionID) return
        // Title, compaction, and transient generation calls would otherwise
        // steal the first-byte timing from the step the user is watching.
        const kind = (event as { kind?: string }).kind
        if (kind !== undefined && kind !== "primary") return
        const model = event.model as { providerID?: string; id?: string } | undefined
        const timing: NetworkTiming = {
          sessionID,
          providerID: model?.providerID,
          modelID: model?.id,
          startedAt: Date.now(),
        }
        requestTimings.set(event.request, timing)
        attachPendingNetwork(timing)
      } catch (error) {
        console.error("opencode-v2-metrics: http.request hook failed", error)
      }
    })

    await ctx.session.hook("http.response", async (event) => {
      const timing = requestTimings.get(event.request)
      if (!timing) return

      const markFirstByte = () => {
        if (timing.firstByteAt !== undefined) return
        timing.firstByteAt = Date.now()
        applyNetworkFirstByte(timing)
      }

      try {
        const body = event.response.body
        if (!body) {
          markFirstByte()
          requestTimings.delete(event.request)
          return
        }

        const reader = body.getReader()
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read()
              if (!chunk.done && chunk.value && chunk.value.byteLength > 0) markFirstByte()
              if (chunk.done) {
                controller.close()
                requestTimings.delete(event.request)
                return
              }
              controller.enqueue(chunk.value)
            } catch (error) {
              requestTimings.delete(event.request)
              controller.error(error)
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason)
            } finally {
              requestTimings.delete(event.request)
            }
          },
        })

        event.response = new Response(stream, {
          status: event.response.status,
          statusText: event.response.statusText,
          headers: new Headers(event.response.headers),
        })
      } catch (error) {
        console.error("opencode-v2-metrics: http.response hook failed", error)
      }
    })

    const controller = new AbortController()
    void (async () => {
      for await (const rawEvent of ctx.event.subscribe({ signal: controller.signal })) {
        const event = rawEvent as UnknownRecord
        const eventType = text(event.type)
        const data = isRecord(event.data) ? event.data : undefined
        if (!eventType || !data) continue

        const eventID = text(event.id)
        if (eventID) {
          if (shared.processed.has(eventID)) {
            // Another instance already applied this event to the shared state.
            // Republish the current snapshot so this instance's GUI subscribers
            // stay in sync without counting the event twice.
            const sessionID = text(data.sessionID)
            const snapshot = sessionID ? latest.get(sessionID) : undefined
            if (snapshot) {
              const now = Date.now()
              if (now - (lastEmitAt.get(snapshot.sessionID) ?? 0) >= EMIT_INTERVAL_MS) {
                lastEmitAt.set(snapshot.sessionID, now)
                void rpc.events.emit("updated", { metrics: snapshot })
              }
            }
            continue
          }
          rememberEvent(eventID)
        }

        if (eventType === "session.deleted") {
          const sessionID = text(data.sessionID)
          if (!sessionID) continue
          latest.delete(sessionID)
          sessionStats.delete(sessionID)
          lastEmitAt.delete(sessionID)
          pendingNetwork.delete(sessionID)
          for (const key of steps.keys()) {
            if (key.startsWith(`${sessionID}:`)) steps.delete(key)
          }
          continue
        }

        if (eventType === "session.step.started") {
          const sessionID = text(data.sessionID)
          const assistantMessageID = text(data.assistantMessageID)
          const model = modelRef(data.model)
          const startedAt = number(data.started) ?? number(event.created) ?? Date.now()
          if (!sessionID || !assistantMessageID || !model) continue

          const inherited = latest.get(sessionID)
          const stats = sessionStats.get(sessionID)
          const metrics: MetricsValue = {
            sessionID,
            assistantMessageID,
            status: "streaming",
            model,
            startedAt,
            outputTokensPerSecond: inherited?.outputTokensPerSecond,
            cacheHitRate: inherited?.cacheHitRate,
            cacheStale: inherited?.cacheHitRate !== undefined,
            averageOutputTokensPerSecond: averageRate(stats) ?? inherited?.averageOutputTokensPerSecond,
            averageFirstTokenMs: stats?.firstTokenSteps
              ? stats.firstTokenMs / stats.firstTokenSteps
              : inherited?.averageFirstTokenMs,
            averageNetworkFirstByteMs: stats?.networkFirstByteSteps
              ? stats.networkFirstByteMs / stats.networkFirstByteSteps
              : inherited?.averageNetworkFirstByteMs,
            averageGenerationMs: stats?.completedSteps
              ? stats.wallMs / stats.completedSteps
              : inherited?.averageGenerationMs,
            sessionCacheHitRate: stats?.cacheSamples
              ? cacheRate(stats.inputTokens, stats.cacheReadTokens)
              : inherited?.sessionCacheHitRate,
            completedSteps: stats?.completedSteps ?? inherited?.completedSteps,
          }
          const step: ActiveStep = { metrics, textChars: 0, reasoningChars: 0 }
          steps.set(`${sessionID}:${assistantMessageID}`, step)
          const queue = pendingNetwork.get(sessionID)
          let pendingIndex = -1
          if (queue) {
            pendingIndex = queue.findIndex(
              (timing) => timing.providerID === model.providerID && timing.modelID === model.modelID,
            )
            // Model ids can differ between the request hook and the step event;
            // the oldest queued request of the session is still the right one.
            if (pendingIndex < 0 && queue.length > 0) pendingIndex = 0
          }
          if (queue && pendingIndex >= 0) {
            const timing = queue.splice(pendingIndex, 1)[0]
            if (queue.length === 0) pendingNetwork.delete(sessionID)
            timing.attached = true
            step.networkStartedAt = timing.startedAt
            if (timing.firstByteAt !== undefined) {
              metrics.networkFirstByteMs = Math.max(0, timing.firstByteAt - timing.startedAt)
            }
          }
          emit(metrics, true)
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
            step.streamStartedAt ??= firstTextAt
            step.lastDeltaAt = Math.max(step.lastDeltaAt ?? 0, firstTextAt)
          }
          emit({ ...step.metrics }, true)
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
          touchStream(step, now)
          step.metrics.generationMs = Math.max(0, now - step.metrics.startedAt)
          step.metrics.liveOutputTokensPerSecond = liveRate(step, now)
          step.metrics.rateEstimated = true
          emit({ ...step.metrics })
          continue
        }

        if (eventType === "session.reasoning.delta") {
          const sessionID = text(data.sessionID)
          const assistantMessageID = text(data.assistantMessageID)
          const delta = typeof data.delta === "string" ? data.delta : ""
          if (!sessionID || !assistantMessageID || delta.length === 0) continue

          const step = steps.get(`${sessionID}:${assistantMessageID}`)
          if (!step) continue

          step.reasoningChars += delta.length
          const now = number(event.created) ?? Date.now()
          if (step.metrics.firstTextAt === undefined) {
            step.metrics.firstTextAt = now
            step.metrics.firstTokenMs = Math.max(0, now - step.metrics.startedAt)
          }
          touchStream(step, now)
          step.metrics.generationMs = Math.max(0, now - step.metrics.startedAt)
          step.metrics.liveOutputTokensPerSecond = liveRate(step, now)
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
          const wallMs = Math.max(0, completedAt - previous.startedAt)
          const streamMs =
            step.streamStartedAt !== undefined
              ? Math.max(0, (step.lastDeltaAt ?? completedAt) - step.streamStartedAt)
              : 0
          const totalGeneratedTokens =
            outputTokens !== undefined || reasoningTokens !== undefined
              ? (outputTokens ?? 0) + (reasoningTokens ?? 0)
              : undefined
          const estimatedRate =
            step.textChars + step.reasoningChars > 0 && wallMs > 0
              ? (step.textChars + step.reasoningChars) / shared.charsPerToken / (wallMs / 1000)
              : undefined
          const exactRate =
            totalGeneratedTokens !== undefined && totalGeneratedTokens > 0 && wallMs > 0
              ? totalGeneratedTokens / (wallMs / 1000)
              : undefined

          const previousStats = sessionStats.get(sessionID) ?? emptyStats()
          const nextStats = { ...previousStats }
          if (eventType === "session.step.ended" && totalGeneratedTokens !== undefined && wallMs > 0) {
            nextStats.generatedTokens += totalGeneratedTokens
            nextStats.wallMs += wallMs
            nextStats.completedSteps += 1
            if (previous.firstTokenMs !== undefined) {
              nextStats.firstTokenMs += previous.firstTokenMs
              nextStats.firstTokenSteps += 1
            }
            if (previous.networkFirstByteMs !== undefined) {
              nextStats.networkFirstByteMs += previous.networkFirstByteMs
              nextStats.networkFirstByteSteps += 1
            }
            if (inputTokens !== undefined && cacheReadTokens !== undefined) {
              nextStats.inputTokens += inputTokens
              nextStats.cacheReadTokens += cacheReadTokens
              nextStats.cacheSamples += 1
            }
            sessionStats.set(sessionID, nextStats)
            trim(sessionStats)
          }

          if (exactRate !== undefined && step.textChars + step.reasoningChars > 0 && totalGeneratedTokens !== undefined) {
            shared.charsPerToken = Math.min(
              MAX_CHARS_PER_TOKEN,
              Math.max(MIN_CHARS_PER_TOKEN, (step.textChars + step.reasoningChars) / totalGeneratedTokens),
            )
          }

          const rate = exactRate ?? estimatedRate ?? previous.liveOutputTokensPerSecond ?? previous.outputTokensPerSecond
          const cacheHitRate = exactCacheRate ?? previous.cacheHitRate
          const metrics: MetricsValue = {
            ...previous,
            status: eventType === "session.step.failed" ? "error" : "completed",
            completedAt,
            generationMs: wallMs,
            streamMs,
            outputTokens: outputTokens ?? previous.outputTokens,
            inputTokens: inputTokens ?? previous.inputTokens,
            reasoningTokens: reasoningTokens ?? previous.reasoningTokens,
            cacheReadTokens: cacheReadTokens ?? previous.cacheReadTokens,
            cacheWriteTokens: cacheWriteTokens ?? previous.cacheWriteTokens,
            cacheHitRate,
            cacheStale: exactCacheRate === undefined && cacheHitRate !== undefined,
            liveOutputTokensPerSecond: undefined,
            outputTokensPerSecond: rate,
            averageOutputTokensPerSecond:
              averageRate(nextStats) ?? previous.averageOutputTokensPerSecond ?? rate,
            averageFirstTokenMs: nextStats.firstTokenSteps
              ? nextStats.firstTokenMs / nextStats.firstTokenSteps
              : previous.averageFirstTokenMs,
            averageNetworkFirstByteMs: nextStats.networkFirstByteSteps
              ? nextStats.networkFirstByteMs / nextStats.networkFirstByteSteps
              : previous.averageNetworkFirstByteMs,
            averageGenerationMs: nextStats.completedSteps
              ? nextStats.wallMs / nextStats.completedSteps
              : previous.averageGenerationMs,
            sessionCacheHitRate: nextStats.cacheSamples
              ? cacheRate(nextStats.inputTokens, nextStats.cacheReadTokens)
              : previous.sessionCacheHitRate,
            completedSteps: nextStats.completedSteps || previous.completedSteps,
            rateEstimated: exactRate === undefined,
            finish: text(data.finish),
            error: isRecord(data.error) ? text(data.error.message) : undefined,
          }

          steps.delete(key)
          emit(metrics, true)
          trim(latest)
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("opencode-v2-metrics event loop failed", error)
    })

    return () => {
      controller.abort()
      void rpc.dispose()
      void ctx.storage.remove("last-settled")
    }
  },
})
