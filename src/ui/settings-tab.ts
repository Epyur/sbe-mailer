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
      .setName('Подпись');

    new Setting(containerEl)
      .setName('Должность')
      .setDesc('Подставляется в шаблон как {{Должность}} (объединяется через запятую с учёной степенью и званием).')
      .addText(text => text
        .setPlaceholder('Главный инженер')
        .setValue(this.plugin.settings.position)
        .onChange(async (value) => {
          this.plugin.settings.position = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Учёная степень (при наличии)')
      .setDesc('Например «канд. техн. наук».')
      .addText(text => text
        .setPlaceholder('канд. техн. наук')
        .setValue(this.plugin.settings.degree)
        .onChange(async (value) => {
          this.plugin.settings.degree = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Учёное звание (при наличии)')
      .setDesc('Например «доцент».')
      .addText(text => text
        .setPlaceholder('доцент')
        .setValue(this.plugin.settings.rank)
        .onChange(async (value) => {
          this.plugin.settings.rank = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Телефон')
      .setDesc('Подставляется в шаблон как {{Телефон}}.')
      .addText(text => text
        .setPlaceholder('+7 (999) 123-45-67')
        .setValue(this.plugin.settings.phone)
        .onChange(async (value) => {
          this.plugin.settings.phone = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('E-mail')
      .setDesc('Подставляется в шаблон как {{Почта}}.')
      .addText(text => text
        .setPlaceholder('polishchuk@tn.ru')
        .setValue(this.plugin.settings.email)
        .onChange(async (value) => {
          this.plugin.settings.email = value.trim();
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

    new Setting(containerEl)
      .setHeading()
      .setName('Права доступа');

    const permsDiv = containerEl.createDiv({ cls: 'tn-mail-meta' });
    permsDiv.setText('Загрузка…');
    void this.renderPermissions(permsDiv);
  }

  /** Вкладка «Права доступа»: только admin может просматривать и менять роли. */
  private async renderPermissions(container: HTMLElement): Promise<void> {
    const roleLabels: Record<string, string> = {
      viewer: 'Просмотр',
      commenter: 'Просмотр + комментарии',
      editor: 'Редактор',
      admin: 'Администратор',
    };
    try {
      const me = await this.plugin.syncService.getMyPermission();
      if (!me.hasAccess) {
        container.setText('Нет доступа к серверу. Запросите ключ в ЦУП и получите доступ у администратора.');
        return;
      }
      if (me.role !== 'admin') {
        container.setText(`Ваша роль: ${roleLabels[me.role] || me.role}. Только администратор может управлять правами.`);
        return;
      }
      container.empty();

      // Общий доступ
      const commonDiv = container.createDiv({ cls: 'tn-mail-mb-8' });
      const commonLabel = commonDiv.createDiv({ cls: 'tn-mail-meta', text: 'Общий доступ (для всех, кому не назначена роль):' });
      const commonSelect = commonDiv.createEl('select', { cls: 'tn-mail-select' });
      commonSelect.createEl('option', { value: '', text: 'Нет общего доступа' });
      commonSelect.createEl('option', { value: 'viewer', text: 'Просмотр' });
      commonSelect.createEl('option', { value: 'commenter', text: 'Просмотр + комментарии' });
      commonSelect.createEl('option', { value: 'editor', text: 'Редактор' });
      commonSelect.value = await this.plugin.syncService.getCommonAccess();
      commonSelect.addEventListener('change', async () => {
        try {
          await this.plugin.syncService.setCommonAccess(commonSelect.value);
          new Notice('Общий доступ обновлён');
        } catch (e: unknown) {
          new Notice(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      commonDiv.appendChild(commonLabel);
      commonDiv.appendChild(commonSelect);

      const perms = await this.plugin.syncService.listPermissions();
      const table = container.createEl('table', { cls: 'tn-table' });
      const thead = table.createEl('thead');
      const hr = thead.createEl('tr');
      hr.createEl('th').setText('Email');
      hr.createEl('th').setText('Роль');
      hr.createEl('th').setText('Действия');
      const tbody = table.createEl('tbody');
      for (const p of perms) {
        const row = tbody.createEl('tr');
        row.createEl('td').setText(p.email);
        const roleCell = row.createEl('td');
        const isOwner = p.email === me.email;
        if (isOwner) {
          roleCell.setText(`${roleLabels[p.role] || p.role} (это вы)`);
        } else {
          const roleSelect = roleCell.createEl('select', { cls: 'tn-mail-select' });
          roleSelect.createEl('option', { value: 'viewer', text: 'Просмотр' });
          roleSelect.createEl('option', { value: 'commenter', text: 'Просмотр + комментарии' });
          roleSelect.createEl('option', { value: 'editor', text: 'Редактор' });
          roleSelect.createEl('option', { value: 'admin', text: 'Администратор' });
          roleSelect.value = p.role;
          roleSelect.addEventListener('change', async () => {
            try {
              await this.plugin.syncService.setPermission(p.email, roleSelect.value);
              new Notice(`Роль ${p.email} обновлена`);
            } catch (e: unknown) {
              new Notice(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
            }
          });
        }
        const actionsCell = row.createEl('td');
        if (!isOwner) {
          const removeBtn = actionsCell.createEl('button', { text: '✖ Убрать', cls: 'tn-btn tn-btn-ghost' });
          removeBtn.addEventListener('click', async () => {
            try {
              await this.plugin.syncService.setPermission(p.email, '');
              new Notice(`Доступ ${p.email} отозван`);
              container.empty();
              container.setText('Загрузка…');
              void this.renderPermissions(container);
            } catch (e: unknown) {
              new Notice(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
            }
          });
        }
      }
      const addRow = tbody.createEl('tr');
      const emailCell = addRow.createEl('td');
      const emailInput = emailCell.createEl('input', { attr: { type: 'text', placeholder: 'email@tn.ru' }, cls: 'tn-mail-input' });
      const roleCell = addRow.createEl('td');
      const roleSelect = roleCell.createEl('select', { cls: 'tn-mail-select' });
      roleSelect.createEl('option', { value: 'viewer', text: 'Просмотр' });
      roleSelect.createEl('option', { value: 'commenter', text: 'Просмотр + комментарии' });
      roleSelect.createEl('option', { value: 'editor', text: 'Редактор' });
      roleSelect.createEl('option', { value: 'admin', text: 'Администратор' });
      const actionCell = addRow.createEl('td');
      const addBtn = actionCell.createEl('button', { text: '➕ Добавить', cls: 'tn-btn tn-btn-primary' });
      addBtn.addEventListener('click', async () => {
        const email = emailInput.value.trim();
        if (!email) { new Notice('Введите email'); return; }
        try {
          await this.plugin.syncService.setPermission(email, roleSelect.value);
          new Notice(`Доступ выдан: ${email}`);
          container.empty();
          container.setText('Загрузка…');
          void this.renderPermissions(container);
        } catch (e: unknown) {
          new Notice(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    } catch (e: unknown) {
      container.setText(`Не удалось загрузить права: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}