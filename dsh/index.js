import Schema from '@deepseek-ai/schemastery';
import { registerRoutes } from './files.mjs';

export const name = 'ai-coding-workbench';
export const inject = ['connection'];
export const Config = Schema.object({});

export function apply(ctx) {
  registerRoutes(ctx);
}
