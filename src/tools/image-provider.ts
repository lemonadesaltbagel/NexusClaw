// ---------------------------------------------------------------------------
// ImageProvider — minimal interface for "describe this image" / "describe
// these images". Decouples the analyze_image handler from any specific SDK.
//
// Two methods, both optional shape-wise:
//   * describeImage(prompt, image)            — single-image call
//   * describeImages?(prompt, images[])       — provider-native batch
//
// If a provider only implements `describeImage`, the handler falls back to
// looping with "Describe image N of M." prefixes.
// ---------------------------------------------------------------------------

import type Anthropic from "@anthropic-ai/sdk";

/**
 * Reference to one image source. Distilled from the handler's path
 * classification so the provider only sees one of two shapes.
 */
export type ImageRef =
  | { kind: "url";    url: string }
  | { kind: "base64"; data: string; mediaType: string };

export interface DescribeResult {
  text: string;
}

export interface ImageProvider {
  /** Identifier for logging and the `details.attempts` trail. */
  name: string;          // provider name, e.g. "anthropic"
  model: string;         // model id

  describeImage(prompt: string, image: ImageRef): Promise<DescribeResult>;
  /**
   * Optional native-batch path. When present the handler uses it directly;
   * otherwise it loops through describeImage. Implementing this is a pure
   * optimization — semantically identical to calling describeImage N times
   * with "Describe image N of M." prefixes.
   */
  describeImages?(prompt: string, images: ImageRef[]): Promise<DescribeResult>;
}

// ---------------------------------------------------------------------------
// Anthropic provider — calls messages.create with image content blocks.
// ---------------------------------------------------------------------------

export class AnthropicImageProvider implements ImageProvider {
  readonly name = "anthropic";

  constructor(
    private readonly client: Anthropic,
    public readonly model: string,
  ) {}

  async describeImage(prompt: string, image: ImageRef): Promise<DescribeResult> {
    const imgBlock = this.toAnthropicBlock(image);
    const res = await this.client.messages.create({
      model:      this.model,
      max_tokens: 1024,
      messages:   [{ role: "user", content: [imgBlock, { type: "text", text: prompt }] }],
    });
    return { text: this.extractText(res) };
  }

  // Native batch — Anthropic accepts multiple image blocks in one message.
  async describeImages(prompt: string, images: ImageRef[]): Promise<DescribeResult> {
    const blocks = images.map((i) => this.toAnthropicBlock(i)) as Array<
      Anthropic.Messages.ContentBlockParam
    >;
    blocks.push({ type: "text", text: prompt });
    const res = await this.client.messages.create({
      model:      this.model,
      max_tokens: 2048,
      messages:   [{ role: "user", content: blocks }],
    });
    return { text: this.extractText(res) };
  }

  private toAnthropicBlock(image: ImageRef): Anthropic.Messages.ContentBlockParam {
    if (image.kind === "url") {
      return { type: "image", source: { type: "url", url: image.url } } as
        Anthropic.Messages.ContentBlockParam;
    }
    return {
      type:   "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    } as Anthropic.Messages.ContentBlockParam;
  }

  private extractText(res: Anthropic.Messages.Message): string {
    const parts: string[] = [];
    for (const b of res.content) {
      if (b.type === "text") parts.push(b.text);
    }
    return parts.join("\n").trim();
  }
}

// ---------------------------------------------------------------------------
// Registry — process-wide map of provider-name → factory closure. Lets the
// handler resolve a provider+model at execution time without importing
// SDK clients. Populated at startup (CLI / serve.ts).
// ---------------------------------------------------------------------------

type ProviderFactory = (model: string) => ImageProvider;

const registry = new Map<string, ProviderFactory>();

export function registerImageProvider(providerName: string, factory: ProviderFactory): void {
  registry.set(providerName, factory);
}

export function getImageProviders(): ReadonlyMap<string, ProviderFactory> {
  return registry;
}

/** Build an ImageProvider for a given (providerName, model) pair, or null. */
export function resolveImageProvider(
  providerName: string,
  model: string,
): ImageProvider | null {
  const factory = registry.get(providerName);
  if (!factory) return null;
  return factory(model);
}

/** Test helper — clear all registered factories. */
export function clearImageProviders(): void {
  registry.clear();
}
