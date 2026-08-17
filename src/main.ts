import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { MailDatabase } from './database/mail-db';
import { MailSyncService } from './services/sync.service';
import { MailView, SBE_MAIL_VIEW_TYPE } from './ui/mail-view';
import { MailSettingsTab } from './ui/settings-tab';
import { publishService, unpublishService } from '../../sbe-core/src/bridge';
import type { SbeMailApi } from '../../sbe-core/src/types';
import type { MailDbData } from './types/mail';
import { errorMessage } from '../../sbe-core/src/utils/errors';

export interface SbeMailSettings {
  apiUrl: string;
  defaultAuthor: string;
  docxTemplatePath: string;
  docxExportFolder: string;
  selectedDirectionIds: number[];
}

const DEFAULT_SETTINGS: SbeMailSettings = {
  apiUrl: 'https://epyur.fvds.ru',
  defaultAuthor: 'Кравченко А.А.',
  docxTemplatePath: '',
  docxExportFolder: 'Экспорт писем',
  selectedDirectionIds: [],
};

export default class SbeMailPlugin extends Plugin {
  settings!: SbeMailSettings;
  mailDb!: MailDatabase;
  syncService!: MailSyncService;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.mailDb = new MailDatabase(this.app);
    await this.mailDb.init();
    this.syncService = new MailSyncService(this.mailDb, () => this.settings.apiUrl);

    // Одноразовая миграция из legacy-БД монолита (yourbase/mailer_data.json).
    await this.migrateLegacyOnce();

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
    if (this.mailDb.getAllEmails().length > 0 || this.mailDb.getDirections().length > 0) return;
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
      new Notice(`Письма: импортировано ${emails.length} писем из legacy-БД. Они будут отправлены на сервер при первой синхронизации.`);
    } catch (e: unknown) {
      console.warn('Письма: не удалось импортировать legacy-БД:', errorMessage(e));
    }
  }
}