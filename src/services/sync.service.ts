import { requestUrl, RequestUrlParam } from 'obsidian';
import { getService } from '../../../sbe-core/src/bridge';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import type { MailDatabase } from '../database/mail-db';
import type { MailItem, PushResponse, PullResponse, SearchResultItem } from '../types/mail';

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/** Синхронизация с mailer-service через JWT из ЦУП. Сервер — канон, локально — кэш. */
export class MailSyncService {
  private db: MailDatabase;
  private getApiUrl: () => string;

  constructor(db: MailDatabase, getApiUrl: () => string) {
    this.db = db;
    this.getApiUrl = getApiUrl;
  }

  get baseUrl(): string {
    return this.getApiUrl().trim().replace(/\/+$/, '');
  }

  async sync(): Promise<SyncResult> {
    const token = await this.getToken();
    const dirty = this.db.getAllEmails().filter(e => e.sync_status === 'local');
    let pushed = 0;
    if (dirty.length > 0) {
      const res = await this.push(token, dirty);
      pushed = res.inserted + res.updated;
      for (const e of dirty) e.sync_status = 'synced';
      await this.db.save();
    }
    const pulled = await this.pull(token);
    this.db.mergeFromServer(pulled.emails);
    await this.db.save();
    return { pushed, pulled: pulled.emails.length };
  }

  /** Только pull + merge (без push). Используется перед повторной миграцией, чтобы
   *  свежая копия сервера не дала импортировать письма, уже попавшие туда под новым id. */
  async pullAndMerge(): Promise<number> {
    const token = await this.getToken();
    const pulled = await this.pull(token);
    this.db.mergeFromServer(pulled.emails);
    await this.db.save();
    return pulled.emails.length;
  }

  private async getToken(): Promise<string> {
    const apstore = await getService('sbe-apstore');
    return apstore.auth.getToken('mailer');
  }

  /** Скачивает DOCX-шаблон письма с сервера (JWT-защищённый endpoint). */
  async downloadTemplate(): Promise<ArrayBuffer> {
    const token = await this.getToken();
    const res = await this.requestArrayBuffer({
      url: `${this.baseUrl}/api/mailer/template`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) throw new Error('Ключ доступа недействителен. Запросите новый ключ в ЦУП.');
    if (res.status === 403) throw new Error('Нет прав доступа к письмам. Обратитесь к администратору.');
    if (res.status === 404) throw new Error('Шаблон письма не найден на сервере.');
    if (res.status !== 200) throw new Error(this.errorText(res) || `Сервер вернул HTTP ${res.status}`);
    if (!res.arrayBuffer) throw new Error('Сервер вернул пустой файл шаблона.');
    return res.arrayBuffer;
  }

  /** Полнотекстовый поиск по письмам на сервере (tsvector+pg_trgm).
   *  ⚠️ НЕ используется в текущей версии: серверный endpoint /api/mailer/search отключён
   *  (LLM-генерация работает по локальной базе). Сохранён на случай возврата серверного поиска. */
  async search(query: string, limit = 10): Promise<SearchResultItem[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/mailer/search`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, limit }),
    });
    if (res.status === 401) throw new Error('Ключ доступа недействителен. Запросите новый ключ в ЦУП.');
    if (res.status === 403) throw new Error('Нет прав доступа к письмам. Обратитесь к администратору.');
    if (res.status !== 200) throw new Error(this.errorText(res) || `Сервер вернул HTTP ${res.status}`);
    try {
      const data = JSON.parse(res.text) as { results?: SearchResultItem[] };
      return Array.isArray(data.results) ? data.results : [];
    } catch (e: unknown) {
      console.warn('Письма: не JSON в ответе search:', errorMessage(e));
      return [];
    }
  }

  private async push(token: string, emails: MailItem[]): Promise<PushResponse> {
    const res = await this.request({
      url: `${this.baseUrl}/api/mailer/sync/push`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ emails }),
    });
    if (res.status === 401) throw new Error('Ключ доступа недействителен. Запросите новый ключ в ЦУП.');
    if (res.status === 403) throw new Error('Нет прав доступа к письмам. Обратитесь к администратору.');
    if (res.status !== 200) throw new Error(this.errorText(res) || `Сервер вернул HTTP ${res.status}`);
    try {
      return JSON.parse(res.text) as PushResponse;
    } catch (e: unknown) {
      console.warn('Письма: не JSON в ответе push:', errorMessage(e));
      return { inserted: 0, updated: 0 };
    }
  }

  private async pull(token: string): Promise<PullResponse> {
    const res = await this.request({
      url: `${this.baseUrl}/api/mailer/sync/pull`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) throw new Error('Ключ доступа недействителен. Запросите новый ключ в ЦУП.');
    if (res.status === 403) throw new Error('Нет прав доступа к письмам. Обратитесь к администратору.');
    if (res.status !== 200) throw new Error(this.errorText(res) || `Сервер вернул HTTP ${res.status}`);
    try {
      return JSON.parse(res.text) as PullResponse;
    } catch (e: unknown) {
      console.warn('Письма: не JSON в ответе pull:', errorMessage(e));
      return { emails: [] };
    }
  }

  private errorText(res: { status: number; text: string }): string {
    if (!res.text) return '';
    try {
      const data = JSON.parse(res.text) as { error?: string };
      return data.error || '';
    } catch (e: unknown) {
      console.warn('Письма: ответ сервера не JSON:', errorMessage(e));
      return '';
    }
  }

  /** requestUrl в Obsidian не имеет таймаута — без обёртки зависший сервер не даст ответа никогда. */
  private async request(
    param: RequestUrlParam,
    timeoutMs = 15000,
  ): Promise<{ status: number; text: string }> {
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        requestUrl({ ...param, throw: false }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} сек`)),
            timeoutMs,
          );
        }),
      ]);
      return { status: response.status, text: response.text };
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }

  /** Как request, но с массивом байт в ответе (для скачивания файла шаблона). */
  private async requestArrayBuffer(
    param: RequestUrlParam,
    timeoutMs = 30000,
  ): Promise<{ status: number; text: string; arrayBuffer?: ArrayBuffer }> {
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        requestUrl({ ...param, throw: false }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} сек`)),
            timeoutMs,
          );
        }),
      ]);
      return { status: response.status, text: response.text, arrayBuffer: response.arrayBuffer };
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }
}