import { Notice } from 'obsidian';
import { getService } from '../../../sbe-core/src/bridge';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import type { SbeLlmApi } from '../../../sbe-core/src/types';
import type { MailItem } from '../types/mail';

export interface DraftResult {
  subject: string;
  text: string;
  sourceCount: number;
}

const SYSTEM_PROMPT = `Ты — помощник технической службы ТЕХНОНИКОЛЬ. На основе локальной базы
писем (полный список приложен) сформулируй проект нового письма, отвечающего на запрос
пользователя. Используй релевантные примеры из базы для стиля и фактического содержания.
Правила:
1. Тон — официально-деловой, как в примерах из базы.
2. Исходи из фактического содержания найденных писем, не выдумывай реквизиты и сроки.
3. Верни ТОЛЬКО JSON: {"subject": "...", "text": "..."} — без пояснений, без markdown.
4. subject — краткая тема (1 строка), text — полный текст письма (без шапки и подписи).`;

/** Генерация черновика нового письма: вся локальная база писем грузится в LLM как контекст.
 *  Серверный поиск отключён (может вернуться позже) — см. sync.service.search. */
export class LlmGenerator {
  private getEmails: () => MailItem[];
  private getModel: () => string;
  private servicePromise: Promise<SbeLlmApi> | null = null;

  constructor(getEmails: () => MailItem[], getModel: () => string) {
    this.getEmails = getEmails;
    this.getModel = getModel;
  }

  private async llm(): Promise<SbeLlmApi> {
    if (!this.servicePromise) {
      this.servicePromise = getService('sbe-llm').catch((e: unknown) => {
        this.servicePromise = null;
        new Notice(`Письма: включите плагин sbe-llm и настройте API-ключ (${errorMessage(e)})`);
        throw e;
      });
    }
    return this.servicePromise;
  }

  private resolveModel(model?: string): string {
    if (model && model.trim()) return model.trim();
    return this.getModel();
  }

  /** Формирует контекст из всей локальной базы писем. */
  private buildContext(): string {
    const emails = this.getEmails();
    const parts: string[] = [];
    for (let i = 0; i < emails.length; i++) {
      const e = emails[i];
      const body = (e.text || '').replace(/\s+/g, ' ').trim();
      parts.push(
        `[Письмо ${i + 1}] №${e.number || 'без номера'} (${e.author || 'автор неизвестен'})\n` +
        `Направление: ${e.direction_name || ''}\n` +
        `Тема: ${e.subject}\n` +
        `Содержимое: ${body.substring(0, 500)}`,
      );
    }
    return parts.join('\n\n');
  }

  /** Генерирует черновик: локальная база грузится целиком, серверный поиск не используется. */
  async generateDraft(userRequest: string, model?: string): Promise<DraftResult> {
    const emails = this.getEmails();
    if (emails.length === 0) {
      throw new Error('Локальная база писем пуста. Синхронизируйтесь с сервером.');
    }
    const context = this.buildContext();

    const resolvedModel = this.resolveModel(model);
    const api = await this.llm();
    const raw = await api.completeJson<{ subject?: string; text?: string }>(
      SYSTEM_PROMPT,
      `Запрос пользователя: ${userRequest}\n\nЛокальная база писем (${emails.length} шт.):\n\n${context}`,
      resolvedModel ? { model: resolvedModel } : undefined,
    );

    const subject = (raw.subject || '').trim();
    const text = (raw.text || '').trim();
    if (!subject || !text) {
      throw new Error('LLM вернул пустой черновик. Попробуйте ещё раз.');
    }

    return { subject, text, sourceCount: emails.length };
  }
}
