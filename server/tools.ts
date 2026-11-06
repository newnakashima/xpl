import { z } from "zod";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  handler: (input: unknown) => Promise<ToolResult>;
}

export function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  handler: (input: z.output<z.ZodObject<Shape>>) => Promise<ToolResult>,
): ToolDefinition {
  const inputSchema = z.object(shape);
  return { name, description, inputSchema, handler: (input) => handler(inputSchema.parse(input)) };
}
