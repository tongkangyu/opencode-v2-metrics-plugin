import { Rpc } from "@opencode/plugin/rpc"

const modelSchema = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    modelID: { type: "string" },
    variant: { type: "string" },
  },
  required: ["providerID", "modelID"],
  additionalProperties: false,
} as const

const metricsSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    assistantMessageID: { type: "string" },
    status: { type: "string", enum: ["streaming", "completed", "error"] },
    model: modelSchema,
    startedAt: { type: "number" },
    firstTextAt: { type: "number" },
    completedAt: { type: "number" },
    firstTokenMs: { type: "number" },
    outputTokens: { type: "number" },
    inputTokens: { type: "number" },
    reasoningTokens: { type: "number" },
    cacheReadTokens: { type: "number" },
    cacheWriteTokens: { type: "number" },
    cacheHitRate: { type: "number" },
    outputTokensPerSecond: { type: "number" },
    liveOutputTokensPerSecond: { type: "number" },
    rateEstimated: { type: "boolean" },
    cacheStale: { type: "boolean" },
    finish: { type: "string" },
    error: { type: "string" },
  },
  required: ["sessionID", "assistantMessageID", "status", "model", "startedAt"],
  additionalProperties: false,
} as const

export const Metrics = Rpc.define({
  id: "opencode-v2-metrics",
  methods: {
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          metrics: { anyOf: [metricsSchema, { type: "null" }] },
        },
        required: ["metrics"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { metrics: metricsSchema },
        required: ["metrics"],
        additionalProperties: false,
      },
    },
  },
})

export type MetricsValue = {
  sessionID: string
  assistantMessageID: string
  status: "streaming" | "completed" | "error"
  model: {
    providerID: string
    modelID: string
    variant?: string
  }
  startedAt: number
  firstTextAt?: number
  completedAt?: number
  firstTokenMs?: number
  outputTokens?: number
  inputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cacheHitRate?: number
  outputTokensPerSecond?: number
  liveOutputTokensPerSecond?: number
  rateEstimated?: boolean
  cacheStale?: boolean
  finish?: string
  error?: string
}
