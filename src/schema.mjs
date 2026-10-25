import { z } from 'zod';

export const questionSchema = z.object({
  question: z.string().trim().min(1).max(1500),
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(6).refine(items => new Set(items).size === items.length, '选项不能重复'),
  context: z.string().trim().max(200).optional(),
  allow_text: z.boolean().default(true),
  timeout_seconds: z.number().int().min(15).max(600).default(300),
});
