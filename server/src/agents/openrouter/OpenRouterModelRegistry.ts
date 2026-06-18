import type { IClock } from "../../substrate/abstractions/IClock";
import type { IHttpClient } from "../ollama/IHttpClient";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 15_000;

interface OpenRouterModel {
  id: string;
  context_length?: number;
  architecture?: {
    modality?: string;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

/**
 * Fetches free text-capable models from OpenRouter, ranks them by context
 * length (descending), and provides a round-robin cycling interface so the
 * launcher can rotate on rate-limit or model errors.
 *
 * If priorityModels is supplied, those models lead the cycling list (in
 * order). Auto-discovered free models are appended after, deduped. This lets
 * callers pin preferred models while still having a tail-end fallback pool.
 *
 * Free models are identified by pricing.prompt === "0" and
 * pricing.completion === "0". The discovered list is cached for 1 hour.
 */
export class OpenRouterModelRegistry {
  private models: string[] = [];
  private currentIndex = 0;
  private fetchedAt: number | null = null;
  private contextLengths: Map<string, number> = new Map();

  constructor(
    private readonly httpClient: IHttpClient,
    private readonly clock: IClock,
    private readonly apiKey: string,
    private readonly priorityModels: string[] = [],
  ) {}

  async getModels(): Promise<string[]> {
    await this.ensureFresh();
    return this.models;
  }

  currentModel(): string | undefined {
    return this.models[this.currentIndex];
  }

  contextLengthFor(modelId: string): number | undefined {
    const len = this.contextLengths.get(modelId);
    return len && len > 0 ? len : undefined;
  }

  advanceModel(): void {
    if (this.models.length === 0) return;
    this.currentIndex = (this.currentIndex + 1) % this.models.length;
  }

  /** Force a refresh of the model list on next use. */
  invalidate(): void {
    this.fetchedAt = null;
  }

  private async ensureFresh(): Promise<void> {
    const now = this.clock.now().getTime();
    if (this.fetchedAt !== null && now - this.fetchedAt < CACHE_TTL_MS) {
      return;
    }
    await this.fetch();
  }

  private async fetch(): Promise<void> {
    try {
      const response = await this.httpClient.get(OPENROUTER_MODELS_URL, {
        timeoutMs: FETCH_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as OpenRouterModelsResponse;
      const allModels = data.data ?? [];
      for (const m of allModels) {
        if (m.context_length && m.context_length > 0) {
          this.contextLengths.set(m.id, m.context_length);
        }
      }
      const discovered = filterAndRankFreeTextModels(allModels);
      const prioritySet = new Set(this.priorityModels);
      const tail = discovered.filter((id) => !prioritySet.has(id));
      const merged = [...this.priorityModels, ...tail];
      if (merged.length > 0) {
        this.models = merged;
        this.currentIndex = 0;
        this.fetchedAt = this.clock.now().getTime();
      }
    } catch {
      // Network errors: keep existing list if we have one, otherwise stay empty.
      // Seed with priorityModels so cycling works even without connectivity.
      if (this.models.length === 0 && this.priorityModels.length > 0) {
        this.models = [...this.priorityModels];
        this.fetchedAt = this.clock.now().getTime();
      }
    }
  }
}

function filterAndRankFreeTextModels(models: OpenRouterModel[]): string[] {
  return models
    .filter(isFreeTextModel)
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))
    .map((m) => m.id);
}

function isFreeTextModel(model: OpenRouterModel): boolean {
  const pricing = model.pricing;
  if (!pricing) return false;
  if (pricing.prompt !== "0" || pricing.completion !== "0") return false;
  const modality = model.architecture?.modality ?? "";
  return modality.includes("text");
}
