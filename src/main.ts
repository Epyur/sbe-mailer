import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { MailDatabase } from './database/mail-db';
import { MailSyncService } from './services/sync.service';
import { LlmGenerator } from './services/llm-generator';
import { MailView, SBE_MAIL_VIEW_TYPE } from './ui/mail-view';
import { MailSettingsTab } from './ui/settings-tab';
import { publishService, unpublishService } from '../../sbe-core/src/bridge';
import type { SbeMailApi } from '../../sbe-core/src/types';
import type { MailDbData } from './types/mail';
import { errorMessage } from '../../sbe-core/src/utils/errors';

export interface SbeMailSettings {
  apiUrl: string;
  defaultAuthor: string;
  position: string;
  degree: string;
  rank: string;
  phone: string;
  email: string;
  docxTemplatePath: string;
  docxExportFolder: string;
  selectedDirectionIds: number[];
  llmModel: string;
  legacyMigrated: boolean;
}

const DEFAULT_SETTINGS: SbeMailSettings = {
  apiUrl: 'https://epyur.fvds.ru',
  defaultAuthor: 'И.И. Иванов',
  position: '',
  degree: '',
  rank: '',
  phone: '',
  email: '',
  docxTemplatePath: '',
  docxExportFolder: 'Экспорт писем',
  selectedDirectionIds: [],
  llmModel: 'gpt-5.6-luna',
  legacyMigrated: false,
};

/** Локальный путь шаблона письма, скачанного с сервера. */
const TEMPLATE_LOCAL_PATH = 'yourbase/sbe_mailer/templates/standard.docx';

export default class SbeMailPlugin extends Plugin {
  settings!: SbeMailSettings;
  mailDb!: MailDatabase;
  syncService!: MailSyncService;
  llmGenerator!: LlmGenerator;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.mailDb = new MailDatabase(this.app);
    await this.mailDb.init();
    this.syncService = new MailSyncService(this.mailDb, () => this.settings.apiUrl);
    this.llmGenerator = new LlmGenerator(
      () => this.mailDb.getAllEmails(),
      () => this.settings.llmModel,
      async () => {
        // Известные имена для маскировки ФИО в контексте LLM (ревью 3.5):
        // берём из локального кэша контактов, best-effort.
        try {
          const path = 'yourbase/sbe_contacts/contacts_data.json';
          if (!(await this.app.vault.adapter.exists(path))) return [];
          const raw = await this.app.vault.adapter.read(path);
          const data = JSON.parse(raw) as { contacts?: Array<{ name?: string }> };
          return (data.contacts || []).map((c) => c.name || '').filter(Boolean);
        } catch (e: unknown) {
          console.warn('Письма: не удалось прочитать контакты для маскировки имён:', errorMessage(e));
          return [];
        }
      },
    );

    // Одноразовая миграция из legacy-БД монолита (yourbase/mailer_data.json).
    await this.migrateLegacyOnce();

    // Стандартный шаблон письма: если не выбран — скачать с сервера и подставить по умолчанию.
    await this.ensureDefaultTemplate();

    this.registerView(
      SBE_MAIL_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new MailView(leaf, this),
    );

    this.addSettingTab(new MailSettingsTab(this.app, this));

    // Точка входа — магазин: «Установленные → Открыть». Собственных риббона/команды нет.
    publishService<SbeMailApi>('sbe-mailer', {
      open: async () => {
        await this.activateView();
      },
    }, {
      version: this.manifest.version,
      name: this.manifest.name,
    });
  }

  onunload(): void {
    unpublishService('sbe-mailer');
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData() as Partial<SbeMailSettings>) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SBE_MAIL_VIEW_TYPE)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf(false);
    await leaf.setViewState({ type: SBE_MAIL_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  /** Импорт legacy-БД писем (mailer_data.json монолита) в sbe_mailer. Выполняется один раз. */
  private async migrateLegacyOnce(): Promise<void> {
    const removed = this.mailDb.dedupe();
    if (removed > 0) {
      await this.mailDb.save();
      console.warn(`Письма: удалено ${removed} дубликатов по id из локальной БД`);
    }

    // Флаг в настройках гарантирует одноразовость. Раньше при непустой локальной БД
    // на каждом старте плагина вызывался importMissingLegacy() по всему статичному
    // legacy-файлу с guard'ом «нет по id/теме в текущей БД» — после удаления письма
    // его тема пропадала из guard'а, и легаси-копия того же письма реимпортировалась
    // как новая (sync_status='local'), затем push возвращал удалённое письмо на сервер
    // и на все машины. С флагом импорт из legacy выполняется максимум один раз в жизни
    // плагина, удаления больше не воскрешаются.
    if (this.settings.legacyMigrated) return;
    if (this.mailDb.getAllEmails().length > 0 || this.mailDb.getDirections().length > 0) {
      this.settings.legacyMigrated = true;
      await this.saveSettings();
      return;
    }

    const adapter = this.app.vault.adapter;
    const legacyPath = 'yourbase/mailer_data.json';
    try {
      const exists = await adapter.exists(legacyPath);
      if (!exists) return;
      const content = await adapter.read(legacyPath);
      const parsed = JSON.parse(content) as Partial<MailDbData>;
      const emails = Array.isArray(parsed.emails) ? parsed.emails : [];
      const directions = Array.isArray(parsed.directions) ? parsed.directions : [];
      if (emails.length === 0 && directions.length === 0) return;

      this.mailDb.importLegacy(emails, directions);
      await this.mailDb.save();
      this.settings.legacyMigrated = true;
      await this.saveSettings();
      new Notice(`Письма: импортировано ${emails.length} писем из legacy-БД. Они будут отправлены на сервер при первой синхронизации.`);
    } catch (e: unknown) {
      console.warn('Письма: не удалось импортировать legacy-БД:', errorMessage(e));
    }
  }

  /** Если шаблон DOCX не выбран — скачать стандартный с сервера и подставить по умолчанию. */
  private async ensureDefaultTemplate(): Promise<void> {
    if (this.settings.docxTemplatePath && this.settings.docxTemplatePath.trim() !== '') return;
    try {
      const ok = await this.downloadTemplateToVault();
      if (ok) new Notice('Письма: стандартный шаблон письма загружен с сервера и установлен по умолчанию.');
    } catch (e: unknown) {
      console.warn('Письма: не удалось скачать стандартный шаблон с сервера:', errorMessage(e));
    }
  }

  /** Скачивает шаблон с сервера в вольт и возвращает true, если файл сохранён. */
  async downloadTemplateToVault(): Promise<boolean> {
    const data = await this.syncService.downloadTemplate();
    const adapter = this.app.vault.adapter;
    const dir = TEMPLATE_LOCAL_PATH.substring(0, TEMPLATE_LOCAL_PATH.lastIndexOf('/'));
    if (!(await adapter.exists(dir))) {
      await adapter.mkdir(dir);
    }
    const bytes = new Uint8Array(data);
    await adapter.writeBinary(TEMPLATE_LOCAL_PATH, bytes.buffer as ArrayBuffer);
    this.settings.docxTemplatePath = TEMPLATE_LOCAL_PATH;
    await this.saveSettings();
    return true;
  }
}