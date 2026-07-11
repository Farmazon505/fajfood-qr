import { z } from "zod";
import { config } from "./config";
import type { PerformanceAnalytics, PerformanceInsightReport } from "./types";

const aiResponseSchema = z.object({
  summary: z.string().trim().min(1).max(3000),
  recommendations: z.array(z.unknown()).max(8),
  employeeAdvice: z.array(z.unknown()).max(50)
});

const objectText = (value: unknown, preferredKeys: string[]) => {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const preferred = preferredKeys.map((key) => record[key]).find((item) => typeof item === "string");
  if (typeof preferred === "string" && preferred.trim()) return preferred.trim();
  return Object.values(record).filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(": ").trim();
};

const normalizeEmployeeAdvice = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const waiterId = [record.waiterId, record.employeeId, record.staffId].find((item) => typeof item === "string");
  const advice = objectText(value, ["advice", "recommendation", "text", "action"]);
  return typeof waiterId === "string" && waiterId && advice ? { waiterId, advice } : null;
};

const localReport = (analytics: PerformanceAnalytics, warning = ""): PerformanceInsightReport => {
  const employeeAdvice = Array.from(new Set(analytics.employeePatterns.map((item) => item.waiterId)))
    .map((waiterId) => {
      const pattern = analytics.employeePatterns.find((item) => item.waiterId === waiterId);
      return pattern ? { waiterId, advice: pattern.recommendation } : null;
    })
    .filter((item): item is { waiterId: string; advice: string } => Boolean(item));
  return {
    generatedAt: new Date().toISOString(),
    source: "rules",
    model: "local-pattern-engine",
    summary: analytics.analyzedShiftCount
      ? `Проанализировано смен: ${analytics.analyzedShiftCount}. Найдено повторяющихся проблемных сочетаний «сотрудник — задача»: ${analytics.employeePatterns.length}.`
      : "Завершенных смен пока недостаточно для анализа.",
    recommendations: analytics.recommendations,
    employeeAdvice,
    warning
  };
};

const parseJsonContent = (value: string) => {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed) as unknown;
};

export const isPerformanceAiConfigured = () => Boolean(config.OPENROUTER_API_KEY.trim());

export const generatePerformanceInsights = async (
  analytics: PerformanceAnalytics
): Promise<PerformanceInsightReport> => {
  if (!isPerformanceAiConfigured()) return localReport(analytics, "OpenRouter не настроен, использован локальный анализ.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.AI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "http-referer": config.PUBLIC_BASE_URL || "https://qr.crunchhaus.ru",
        "x-title": "Qrnastol Staff Analytics"
      },
      body: JSON.stringify({
        model: config.AI_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Ты аналитик операционной эффективности ресторана.",
              "Отделяй системные сбои от индивидуальных: массовая низкая оценка одной задачи чаще указывает на неясный стандарт, нехватку ресурсов или неверный процесс.",
              "Не делай медицинских, психологических и юридических выводов. Не предлагай наказания.",
              "Давай короткие проверяемые рекомендации руководителю и уважительные персональные рекомендации сотрудникам.",
              "Верни только JSON строго такого вида: {\"summary\":\"текст\",\"recommendations\":[\"текст\"],\"employeeAdvice\":[{\"waiterId\":\"id\",\"advice\":\"текст\"}]}.",
              "recommendations должен быть массивом строк, без вложенных объектов. Каждый employeeAdvice содержит только waiterId и advice."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              analyzedShiftCount: analytics.analyzedShiftCount,
              roleSummaries: analytics.roleSummaries,
              taskPatterns: analytics.taskPatterns.slice(0, 20),
              employeePatterns: analytics.employeePatterns.slice(0, 40)
            })
          }
        ]
      })
    });
    if (!response.ok) {
      throw new Error(`OpenRouter вернул HTTP ${response.status}`);
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter вернул пустой ответ");
    const parsed = aiResponseSchema.parse(parseJsonContent(content));
    const knownWaiterIds = new Set(analytics.employeePatterns.map((item) => item.waiterId));
    const recommendations = parsed.recommendations
      .map((item) => objectText(item, ["recommendation", "text", "action", "description"]))
      .filter(Boolean)
      .slice(0, 8);
    const employeeAdvice = parsed.employeeAdvice
      .map(normalizeEmployeeAdvice)
      .filter((item): item is { waiterId: string; advice: string } => Boolean(item))
      .filter((item) => knownWaiterIds.has(item.waiterId));
    return {
      generatedAt: new Date().toISOString(),
      source: "openrouter",
      model: config.AI_MODEL,
      summary: parsed.summary,
      recommendations: recommendations.length ? recommendations : analytics.recommendations,
      employeeAdvice,
      warning: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "неизвестная ошибка";
    return localReport(analytics, `ИИ-анализ недоступен: ${message}. Использован локальный анализ.`);
  } finally {
    clearTimeout(timeout);
  }
};
