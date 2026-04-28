import { test, expect, describe } from "bun:test";
import { toOpenAITools, toOpenAIMessages } from "@/core/providers/openai";
import type { MessageParam } from "@/core/types";

// ---------------------------------------------------------------------------
// 1. toOpenAITools — tool definition conversion
// ---------------------------------------------------------------------------

describe("toOpenAITools", () => {
  test("converts tool definitions to OpenAI format", () => {
    const tools = [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object" as const,
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      },
    ];

    const result = toOpenAITools(tools);

    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
      },
    ]);
  });

  test("converts multiple tools", () => {
    const tools = [
      {
        name: "tool_a",
        description: "Tool A",
        input_schema: { type: "object" as const, properties: {} },
      },
      {
        name: "tool_b",
        description: "Tool B",
        input_schema: { type: "object" as const, properties: { x: { type: "number" } }, required: ["x"] },
      },
    ];

    const result = toOpenAITools(tools);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe("tool_a");
    expect(result[1].function.name).toBe("tool_b");
  });

  test("returns empty array for empty input", () => {
    expect(toOpenAITools([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. toOpenAIMessages — message format conversion
// ---------------------------------------------------------------------------

describe("toOpenAIMessages", () => {
  test("prepends system message from string", () => {
    const messages: MessageParam[] = [{ role: "user", content: "Hi" }];
    const result = toOpenAIMessages(messages, "You are helpful");

    expect(result[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(result[1]).toEqual({ role: "user", content: "Hi" });
  });

  test("prepends system message from TextBlockParam array", () => {
    const system = [
      { type: "text" as const, text: "Line 1" },
      { type: "text" as const, text: "Line 2" },
    ];
    const result = toOpenAIMessages([], system);

    expect(result[0]).toEqual({ role: "system", content: "Line 1\nLine 2" });
  });

  test("no system message when undefined", () => {
    const messages: MessageParam[] = [{ role: "user", content: "Hi" }];
    const result = toOpenAIMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "Hi" });
  });

  test("converts simple user string messages", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ];
    const result = toOpenAIMessages(messages);

    expect(result).toEqual([
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
    ]);
  });

  test("converts user messages with text content blocks", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    ];
    const result = toOpenAIMessages(messages);

    expect(result).toEqual([{ role: "user", content: "Part 1\nPart 2" }]);
  });

  test("converts tool_result blocks to tool messages", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_123", content: "file contents here" },
          { type: "tool_result", tool_use_id: "call_456", content: "other result" },
        ] as any,
      },
    ];
    const result = toOpenAIMessages(messages);

    expect(result).toEqual([
      { role: "tool", tool_call_id: "call_123", content: "file contents here" },
      { role: "tool", tool_call_id: "call_456", content: "other result" },
    ]);
  });

  test("converts assistant string messages", () => {
    const messages: MessageParam[] = [
      { role: "assistant", content: "I can help with that" },
    ];
    const result = toOpenAIMessages(messages);

    expect(result).toEqual([{ role: "assistant", content: "I can help with that" }]);
  });

  test("converts assistant messages with text blocks", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the answer" },
        ],
      },
    ];
    const result = toOpenAIMessages(messages);

    expect(result[0]).toEqual({
      role: "assistant",
      content: "Here is the answer",
    });
  });

  test("converts assistant messages with tool_use blocks", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file" },
          { type: "tool_use", id: "call_abc", name: "read_file", input: { file_path: "a.txt" } },
        ],
      },
    ];
    const result = toOpenAIMessages(messages);

    expect(result[0]).toEqual({
      role: "assistant",
      content: "Let me read that file",
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "read_file", arguments: '{"file_path":"a.txt"}' },
        },
      ],
    });
  });

  test("handles assistant with multiple tool_use blocks", () => {
    const messages: MessageParam[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "read_file", input: { file_path: "a.txt" } },
          { type: "tool_use", id: "call_2", name: "write_file", input: { file_path: "b.txt", content: "hi" } },
        ],
      },
    ];
    const result = toOpenAIMessages(messages);

    const msg = result[0] as any;
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toHaveLength(2);
    expect(msg.tool_calls[0].function.name).toBe("read_file");
    expect(msg.tool_calls[1].function.name).toBe("write_file");
  });

  test("handles full conversation flow", () => {
    const messages: MessageParam[] = [
      { role: "user", content: "Read a.txt" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading file" },
          { type: "tool_use", id: "call_1", name: "read_file", input: { file_path: "a.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "hello world" },
        ] as any,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The file contains: hello world" }],
      },
    ];

    const result = toOpenAIMessages(messages, "You are a coding assistant");

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ role: "system", content: "You are a coding assistant" });
    expect(result[1]).toEqual({ role: "user", content: "Read a.txt" });
    expect((result[2] as any).role).toBe("assistant");
    expect((result[2] as any).tool_calls).toHaveLength(1);
    expect(result[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "hello world" });
    expect(result[4]).toEqual({ role: "assistant", content: "The file contains: hello world" });
  });

  test("tool_result with non-string content gets JSON-stringified", () => {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "data" }] },
        ] as any,
      },
    ];
    const result = toOpenAIMessages(messages);

    expect(result[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: JSON.stringify([{ type: "text", text: "data" }]),
    });
  });
});
