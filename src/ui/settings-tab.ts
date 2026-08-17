import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SbeMailPlugin from '../main';

export class MailSettingsTab extends PluginSettingTab {
  plugin: SbeMailPlugin;

  constructor(app: App, plugin: SbeMailPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setHeading()
      .setName('Сервер');

    new Setting(containerEl)
      .setName('Адрес сервера (apiUrl)')
      .setDesc('База URL mailer-service, например https://epyur.fvds.ru. JWT берётся из ЦУП СБЕ — отдельный токен не нужен.')
      .addText(text => text
        .setPlaceholder('https://epyur.fvds.ru')
        .setValue(this.plugin.settings.apiUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setHeading()
      .setName('Письма');

    new Setting(containerEl)
      .setName('Автор по умолчанию')
      .setDesc('Подставляется в поле «Автор» при создании нового письма.')
      .addText(text => text
        .setPlaceholder('И.И. Иванов')
        .setValue(this.plugin.settings.defaultAuthor)
        .onChange(async (value) => {
          this.plugin.settings.defaultAuthor = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setHeading()
      .setName('AI-генерация');

    new Setting(containerEl)
      .setName('Модель LLM')
      .setDesc('Модель для генерации черновиков писем (используется sbe-llm). Пусто — модель по умолчанию.')
      .addText(text => text
        .setPlaceholder('gpt-5.6-luna')
        .setValue(this.plugin.settings.llmModel)
        .onChange(async (value) => {
          this.plugin.settings.llmModel = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setHeading()
      .setName('Экспорт в Word');

    new Setting(containerEl)
      .setName('Шаблон DOCX')
      .setDesc('Путь к шаблону .docx с плейсхолдерами {{Номер}}, {{Тема}}, {{Текст}} и т.д. Пусто — стандартная генерация.')
      .addText(text => text
        .setPlaceholder('Путь к шаблону')
        .setValue(this.plugin.settings.docxTemplatePath)
        .onChange(async (value) => {
          this.plugin.settings.docxTemplatePath = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Папка экспорта')
      .setDesc('Куда сохраняются сгенерированные .docx.')
      .addText(text => text
        .setPlaceholder('Экспорт писем')
        .setValue(this.plugin.settings.docxExportFolder)
        .onChange(async (value) => {
          this.plugin.settings.docxExportFolder = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Скачать стандартный шаблон с сервера')
      .setDesc('Скачивает standard.docx с сервера и ставит его в «Шаблон DOCX». Используется, если шаблон не выбран или нужно обновить.')
      .addButton(btn => btn
        .setButtonText('Скачать с сервера')
        .setCta()
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Загрузка…');
          try {
            const ok = await this.plugin.downloadTemplateToVault();
            if (ok) new Notice('Письма: шаблон скачан с сервера и установлен по умолчанию.');
          } catch (e: unknown) {
            new Notice(`Письма: не удалось скачать шаблон: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText('Скачать с сервера');
          }
        }));
  }
}