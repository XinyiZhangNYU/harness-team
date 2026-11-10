import type { ChatApiFormat } from '../../../../../shared/protocol.ts';
import type { WireFormat } from '../wire.ts';
import { anthropic } from './anthropic.ts';
import { gemini } from './gemini.ts';
import { openaiChat } from './openai-chat.ts';
import { openaiResponses } from './openai-responses.ts';

export const WIRE_FORMATS: Record<ChatApiFormat, WireFormat> = {
  openai_chat: openaiChat,
  openai_responses: openaiResponses,
  anthropic,
  gemini,
};
