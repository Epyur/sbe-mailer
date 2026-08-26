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
4. subject — краткая тема (1 строка), text — полный текст письма (без шапки и подписи).
В контексте e-mail, телефоны и известные имена заменены на [email], [телефон], [имя] —
не восстанавливай их и не ссылайся на них как на реальные данные.`;

// ================= Релевантный отбор (ревью 3.5) =================
// Ранжирование вместо жёсткого фильтра: свободный ввод запроса почти никогда
// не даёт точных совпадений — важна «близость» (подстрока/корень), а не равенство.
// Гарантия: контекст НИКОГДА не пуст — при нехватке совпадений добираем письма
// самого релевантного направления, затем свежие.

const MAX_EMAILS = 20;
const MIN_RELEVANT = 5;

const STOP_WORDS = new Set([
  'и', 'в', 'во', 'на', 'для', 'по', 'с', 'со', 'о', 'об', 'не', 'ни', 'что',
  'чтобы', 'как', 'а', 'но', 'или', 'либо', 'из', 'к', 'ко', 'у', 'за', 'от',
  'то', 'это', 'же', 'бы', 'ли', 'его', 'её', 'ее', 'их', 'ему', 'ей', 'им',
  'нам', 'вам', 'нас', 'вас', 'все', 'вся', 'весь', 'при', 'до', 'про', 'если',
  'да', 'нет', 'уже', 'еще', 'ещё', 'более', 'менее', 'которые', 'который',
  'которая', 'своих', 'своего', 'своей', 'мой', 'твой', 'наш', 'ваш', 'том',
  'те', 'так', 'только', 'когда', 'будет', 'быть', 'можно', 'нужно', 'надо',
]);

function normalizeText(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Значимые токены запроса (без стоп-слов, только с буквами, ≥3 символов). */
function queryTokens(s: string): string[] {
  return normalizeText(s)
    .split(' ')
    .filter((t) => t.length >= 3 && /[a-zа-яё]/.test(t) && !STOP_WORDS.has(t));
}

/** Число «попаданий» токена в поле: 2 — подстрока/равенство, 1 — общий корень ≥5 букв. */
function tokenHits(haystack: string, token: string): number {
  if (!haystack) return 0;
  if (haystack.includes(token)) return 2;
  // Морфология: токены в склонениях делят корень (гидроизоляци/гидроизоляци…),
  // но корень не короче 5 букв — «гидр» (гидравлика) уже не считается.
  let best = 0;
  for (const ft of haystack.split(' ')) {
    if (ft.length < 3) continue;
    if (ft === token) return 2;
    let lcp = 0;
    const max = Math.min(token.length, ft.length);
    while (lcp < max && token.charCodeAt(lcp) === ft.charCodeAt(lcp)) lcp++;
    if (lcp >= 5) best = 1;
  }
  return best;
}

function scoreEmail(e: MailItem, tokens: string[]): number {
  const dir = normalizeText(e.direction_name || '');
  const subj = normalizeText(e.subject || '');
  const text = normalizeText((e.text || '').slice(0, 2000));
  let score = 0;
  for (const t of tokens) {
    score += tokenHits(dir, t) * 3; // направление — самый сильный сигнал
    score += tokenHits(subj, t) * 2;
    score += tokenHits(text, t) * 1;
  }
  return score;
}

function emailDate(e: MailItem): number {
  const t = Date.parse(e.date || e.updated_at || '');
  return Number.isNaN(t) ? 0 : t;
}

/** Направление, лучше всего совпавшее с запросом (для дозаполнения). */
function bestDirection(emails: MailItem[], tokens: string[]): string {
  const dirScores = new Map<string, number>();
  for (const e of emails) {
    const d = e.direction_name || '';
    if (!d) continue;
    const ds = tokens.reduce((acc, t) => acc + tokenHits(normalizeText(d), t), 0);
    dirScores.set(d, (dirScores.get(d) || 0) + ds);
  }
  let best = '';
  let bestScore = 0;
  for (const [d, s] of dirScores) {
    if (s > bestScore) {
      best = d;
      bestScore = s;
    }
  }
  return best;
}

function selectEmails(emails: MailItem[], userRequest: string): { emails: MailItem[]; note: string } {
  const tokens = queryTokens(userRequest);
  const scored = emails
    .map((e) => ({ e, score: tokens.length ? scoreEmail(e, tokens) : 0 }))
    .sort((a, b) => b.score - a.score || emailDate(b.e) - emailDate(a.e));

  const relevant = scored.filter((s) => s.score > 0).slice(0, MAX_EMAILS);

  let picked: MailItem[];
  let note = '';
  if (relevant.length >= MIN_RELEVANT) {
    picked = relevant.map((s) => s.e);
  } else {
    // Добираем письма направления, лучше всего совпавшего с запросом, затем свежие.
    const dir = bestDirection(emails, tokens);
    const rest = scored.filter((s) => s.score === 0 && (!dir || s.e.direction_name === dir));
    const topUp = rest.slice(0, Math.max(0, MIN_RELEVANT - relevant.length));
    picked = relevant.map((s) => s.e).concat(topUp.map((s) => s.e));
    note = dir
      ? 'Прямых совпадений немного — добавлены письма того же направления.'
      : 'Прямых совпадений мало — добавлены последние письма базы.';
  }

  if (picked.length === 0) {
    // Совсем нет совпадений — свежие письма (гарантия непустого контекста).
    picked = [...scored].sort((a, b) => emailDate(b.e) - emailDate(a.e)).slice(0, MAX_EMAILS).map((s) => s.e);
    note = 'Совпадений по запросу не найдено — показаны последние письма базы.';
  }

  return { emails: picked.slice(0, MAX_EMAILS), note };
}

// ================= Санитизация PII (ревью 3.5) =================
// email и телефоны детектируются однозначно по формату — маскируем всегда.
// Имена маскируем ТОЛЬКО из известного списка (авторы писем + контакты), целыми
// словами: «Иванов» → [имя], но «Иваново» (населённый пункт) не трогаем.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+7|8|7)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-()]*\d{2}[\s\-()]*\d{2}|\b[78]\d{10}\b/g;

function sanitizeText(text: string): string {
  return text.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[телефон]');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Известные имена: слова из авторов писем и контактов (≥3 букв, без стоп-слов). */
function knownNameWords(emails: MailItem[], contactNames: string[]): Set<string> {
  const words = new Set<string>();
  const add = (raw: string) => {
    const clean = (raw || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    for (const part of clean.split(/[\s/]/)) {
      const w = part.toLowerCase().replace(/[^\p{L}]/gu, '');
      if (w.length >= 3 && !STOP_WORDS.has(w)) words.add(w);
    }
  };
  for (const e of emails) add(e.author || '');
  for (const c of contactNames) add(c);
  return words;
}

/** Маскирует целые известные слова (не подстроки) — безопасно для топонимов. */
function maskKnownNames(text: string, words: Set<string>): string {
  if (words.size === 0) return text;
  const parts = Array.from(words)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const re = new RegExp('(?<![\\p{L}])(?:' + parts.join('|') + ')(?![\\p{L}])', 'giu');
  return text.replace(re, '[имя]');
}

/** Генерация черновика: вся локальная база писем грузится в LLM как контекст.
 *  Серверный поиск отключён (может вернуться позже) — см. sync.service.search. */
export class LlmGenerator {
  private getEmails: () => MailItem[];
  private getModel: () => string;
  private getContactNames?: () => Promise<string[]>;
  private servicePromise: Promise<SbeLlmApi> | null = null;

  constructor(
    getEmails: () => MailItem[],
    getModel: () => string,
    getContactNames?: () => Promise<string[]>,
  ) {
    this.getEmails = getEmails;
    this.getModel = getModel;
    this.getContactNames = getContactNames;
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

  /** Формирует контекст из выбранных писем с санитизацией PII. */
  private buildContext(emails: MailItem[], nameWords: Set<string>): string {
    const parts: string[] = [];
    for (let i = 0; i < emails.length; i++) {
      const e = emails[i];
      const body = sanitizeText(maskKnownNames((e.text || '').replace(/\s+/g, ' ').trim(), nameWords));
      parts.push(
        `[Письмо ${i + 1}] №${e.number || 'без номера'} (${e.author || 'автор неизвестен'})\n` +
        `Направление: ${sanitizeText(e.direction_name || '')}\n` +
        `Тема: ${sanitizeText(e.subject || '')}\n` +
        `Содержимое: ${body.substring(0, 500)}`,
      );
    }
    return parts.join('\n\n');
  }

  /** Генерирует черновик: релевантные письма + санитизация, контекст не пуст. */
  async generateDraft(userRequest: string, model?: string): Promise<DraftResult> {
    const emails = this.getEmails();
    if (emails.length === 0) {
      throw new Error('Локальная база писем пуста. Синхронизируйтесь с сервером.');
    }

    const contactNames = this.getContactNames ? await this.getContactNames() : [];
    const nameWords = knownNameWords(emails, contactNames);
    const { emails: picked, note } = selectEmails(emails, userRequest);
    const context = this.buildContext(picked, nameWords);

    const resolvedModel = this.resolveModel(model);
    const api = await this.llm();
    const raw = await api.completeJson<{ subject?: string; text?: string }>(
      SYSTEM_PROMPT,
      `Запрос пользователя: ${userRequest}\n\nЛокальная база писем (${picked.length} шт.):\n\n${note ? note + '\n\n' : ''}${context}`,
      resolvedModel ? { model: resolvedModel } : undefined,
    );

    const subject = (raw.subject || '').trim();
    const text = (raw.text || '').trim();
    if (!subject || !text) {
      throw new Error('LLM вернул пустой черновик. Попробуйте ещё раз.');
    }

    return { subject, text, sourceCount: picked.length };
  }
}
