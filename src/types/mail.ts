/** Типы модуля писем SBE. Модель совместима с mailer-service (см. server_back/backend/main.go). */

export interface MailDirection {
  id: number;
  name: string;
  description: string;
  created_at: string;
}

/** Письмо. Поле updated_at — для LWW (сервер авторитетен). */
export interface MailItem {
  id: number;
  number: string;
  subject: string;
  text: string;
  author: string;
  date: string;
  direction_id: number;
  /** Название направления (хранится прямо в письме, чтобы не зависеть от directions[]) */
  direction_name?: string;
  images: string[];
  mdFilePath: string;
  mdFileHash: string;
  lastSyncTime: string;
  sync_status: 'local' | 'synced' | 'conflict';
  created_at: string;
  updated_at: string;
}

export interface MailDbData {
  emails: MailItem[];
  directions: MailDirection[];
}

/** Ответ сервера на pull — массив писем. */
export interface PullResponse {
  emails: MailItem[];
}

/** Ответ сервера на push — количество вставленных/обновлённых. */
export interface PushResponse {
  inserted: number;
  updated: number;
}
