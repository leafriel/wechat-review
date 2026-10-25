import { z } from 'zod';

const sourceField = z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/, '来源对话必须为单行文本');
const sourceFields = { conversation_title: sourceField.optional(), conversation_id: sourceField.optional() };
const hasSource = input => !!(input.conversation_title || input.conversation_id);
const sourceRequired = { message: '请提供来源对话标题 conversation_title 或真实会话 ID conversation_id，不能用项目背景代替。' };
export const conversationSchema = z.object(sourceFields).refine(hasSource, sourceRequired);

export const questionSchema = z.object({
  ...sourceFields,
  question: z.string().trim().min(1).max(1500),
  options: z.array(z.string().trim().min(1).max(200)).min(2).max(6).refine(items => new Set(items).size === items.length, '选项不能重复'),
  context: z.string().trim().max(200).optional(),
  allow_text: z.boolean().default(true),
  timeout_seconds: z.number().int().min(15).max(600).default(300),
}).refine(hasSource, sourceRequired);
