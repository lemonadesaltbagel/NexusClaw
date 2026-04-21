import Anthropic from "@anthropic-ai/sdk";

export function createClient(): Anthropic {
  return new Anthropic();
}
