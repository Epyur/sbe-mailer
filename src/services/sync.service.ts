import { requestUrl, RequestUrlParam } from 'obsidian';
import { getService } from '../../../sbe-core/src/bridge';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import type { MailDatabase } from '../database/mail-db';
import type { MailItem, PushResponse, PullResponse } from '../types/mail';

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

  private async getToken(): Promise<string> {
    const apstore = await getService('sbe-apstore');
    return apstore.auth.getToken('mailer');
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
}