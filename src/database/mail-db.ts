import { App } from 'obsidian';
import type { MailDbData, MailDirection, MailItem } from '../types/mail';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

const DB_DIR = 'yourbase/sbe_mailer';
const DB_PATH = 'yourbase/sbe_mailer/mail_data.json';

/** Локальная БД писем (кэш; сервер — каноническое хранилище). */
export class MailDatabase {
  private app: App;
  private data: MailDbData = { emails: [], directions: [] };

  constructor(app: App) {
    this.app = app;
  }

  async init(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(DB_PATH);
      if (exists) {
        const content = await adapter.read(DB_PATH);
        const parsed = JSON.parse(content) as Partial<MailDbData>;
        this.data = {
          emails: Array.isArray(parsed.emails) ? parsed.emails : [],
          directions: Array.isArray(parsed.directions) ? parsed.directions : [],
        };
      }
    } catch (e: unknown) {
      console.error('Письма: не удалось прочитать БД:', errorMessage(e));
    }
  }

  /** adapter.write не создаёт промежуточные папки — создаём вручную перед записью. */
  private async ensureDataDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(DB_DIR);
    if (!exists) {
      await adapter.mkdir(DB_DIR);
    }
  }

  /** Пишет БД на диск. Никогда не отклоняет промис — ошибки логируются. */
  async save(): Promise<void> {
    try {
      await this.ensureDataDir();
      await this.app.vault.adapter.write(DB_PATH, JSON.stringify(this.data, null, 2));
    } catch (e: unknown) {
      console.error('Письма: не удалось сохранить БД:', errorMessage(e));
    }
  }

  getAllEmails(): MailItem[] {
    return this.data.emails;
  }

  getEmailById(id: number): MailItem | undefined {
    return this.data.emails.find(e => e.id === id);
  }

  addEmail(email: MailItem): void {
    const idx = this.data.emails.findIndex(e => e.id === email.id);
    if (idx !== -1) {
      this.data.emails[idx] = email;
    } else {
      this.data.emails.push(email);
    }
  }

  updateEmail(id: number, updates: Partial<MailItem>): void {
    const idx = this.data.emails.findIndex(e => e.id === id);
    if (idx !== -1) {
      this.data.emails[idx] = { ...this.data.emails[idx], ...updates };
    }
  }

  deleteEmail(id: number): void {
    this.data.emails = this.data.emails.filter(e => e.id !== id);
  }

  getDirections(): MailDirection[] {
    return this.data.directions;
  }

  getDirectionName(directionId: number): string {
    const dir = this.data.directions.find(d => d.id === directionId);
    return dir?.name || '';
  }

  addDirection(dir: MailDirection): void {
    const idx = this.data.directions.findIndex(d => d.id === dir.id);
    if (idx !== -1) {
      this.data.directions[idx] = dir;
    } else {
      this.data.directions.push(dir);
    }
  }

  /** Направление по имени — создаёт при отсутствии, возвращает id. */
  resolveDirectionId(name: string): number {
    const trimmed = name.trim();
    if (!trimmed) return 0;
    const existing = this.data.directions.find(d => d.name === trimmed);
    if (existing) return existing.id;
    const id = Date.now() + Math.floor(Math.random() * 100);
    this.addDirection({
      id,
      name: trimmed,
      description: '',
      created_at: new Date().toISOString(),
    });
    return id;
  }

  /** Слияние писем с сервера (канон). Сервер авторитетен при равном/новом updated_at. */
  mergeFromServer(serverEmails: MailItem[]): void {
    for (const s of serverEmails) {
      const local = this.getEmailById(s.id);
      if (!local) {
        this.data.emails.push(this.fromServer(s));
        continue;
      }
      if (this.compareTime(s.updated_at, local.updated_at) >= 0) {
        this.data.emails[this.data.emails.indexOf(local)] = this.fromServer(s, local);
      }
      // иначе локальная копия новее — оставляем (будет отправлена при следующем push)
    }
  }

  /** Преобразует письмо сервера в локальное, сохраняя направление из локальной копии. */
  private fromServer(s: MailItem, existing?: MailItem): MailItem {
    const directionName = existing && existing.direction_id === s.direction_id && existing.direction_name
      ? existing.direction_name
      : this.getDirectionName(s.direction_id);
    return {
      ...s,
      images: Array.isArray(s.images) ? s.images : [],
      direction_name: directionName || s.direction_name || '',
      sync_status: 'synced',
      lastSyncTime: s.updated_at,
    };
  }

  /** Сравнение ISO-строк времени. -1/0/+1. */
  private compareTime(a: string, b: string): number {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta === tb ? 0 : ta > tb ? 1 : -1;
  }

  /** Импорт из легаси-БД монолита (mailer_data.json) — одноразовая миграция. */
  importLegacy(emails: MailItem[], directions: MailDirection[]): void {
    const now = new Date().toISOString();
    this.data.directions = directions.map(d => ({
      id: d.id,
      name: d.name,
      description: d.description || '',
      created_at: d.created_at || now,
    }));
    this.data.emails = emails.map(e => ({
      ...e,
      images: Array.isArray(e.images) ? e.images : [],
      direction_name: e.direction_name || this.getDirectionName(e.direction_id),
      sync_status: 'local',
      lastSyncTime: e.lastSyncTime || now,
      created_at: e.created_at || e.date || now,
      updated_at: e.updated_at || e.lastSyncTime || e.created_at || now,
    }));
  }
}