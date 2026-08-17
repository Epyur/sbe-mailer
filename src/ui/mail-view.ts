import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type SbeMailPlugin from '../main';
import type { MailItem } from '../types/mail';
import { DocumentService } from '../services/document-service';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

export const SBE_MAIL_VIEW_TYPE = 'sbe-mail-view';

export class MailView extends ItemView {
  plugin: SbeMailPlugin;
  private containerElContent!: HTMLElement;
  private selectedDirectionIds: Set<number> = new Set();
  private createViewActive = false;
  private searchQuery = '';
  private searchTimeout: number | null = null;
  private filterDateFrom = '';
  private filterDateTo = '';
  private filterAuthor = '';

  constructor(leaf: WorkspaceLeaf, plugin: SbeMailPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SBE_MAIL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Письма';
  }

  getIcon(): string {
    return 'mail';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.addClass('tn-mail-container');
    this.containerElContent = container.createDiv();
    this.selectedDirectionIds = new Set(this.plugin.settings.selectedDirectionIds);
    await this.syncAndRender();
  }

  refresh(): void {
    this.renderView();
  }

  private renderView(): void {
    const container = this.containerElContent;
    container.empty();
    this.createViewActive = false;

    const header = container.createDiv({ cls: 'tn-mail-header' });
    header.createEl('h3', { text: '📧 Письма' });
    const newBtn = header.createEl('button', { text: '➕ Новое письмо', cls: 'tn-btn tn-btn-primary' });
    newBtn.addEventListener('click', () => this.showCreateForm());
    const refreshBtn = header.createEl('button', { text: '🔄', cls: 'tn-btn tn-btn-ghost' });
    refreshBtn.addEventListener('click', () => { void this.syncAndRender(); });
    const exportBtn = header.createEl('button', { text: '📄 Экспорт HTML', cls: 'tn-btn tn-btn-ghost' });
    exportBtn.addEventListener('click', () => { void this.exportHtml(); });

    const searchInput = container.createEl('input', { attr: { type: 'text', placeholder: '🔍 Поиск по номеру, теме, тексту...' }, cls: 'tn-mail-input tn-mail-mb-8' });
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      if (this.searchTimeout) window.clearTimeout(this.searchTimeout);
      this.searchTimeout = window.setTimeout(() => this.renderView(), 500);
    });

    const directions = this.plugin.mailDb.getDirections();
    if (directions.length > 0) {
      const filterDiv = container.createDiv({ cls: 'tn-mail-mb-8 tn-mail-filters' });
      filterDiv.createDiv({ text: 'Направления:', cls: 'tn-mail-meta' });
      for (const dir of directions) {
        const wrapper = filterDiv.createEl('label', { cls: 'tn-mail-filter-label' });
        const cb = wrapper.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-mail-cb' });
        cb.checked = this.selectedDirectionIds.has(dir.id);
        cb.addEventListener('change', () => {
          if (cb.checked) {
            this.selectedDirectionIds.add(dir.id);
          } else {
            this.selectedDirectionIds.delete(dir.id);
          }
          this.plugin.settings.selectedDirectionIds = [...this.selectedDirectionIds];
          void this.plugin.saveSettings();
          this.renderView();
        });
        const span = wrapper.createEl('span');
        span.setText(` ${dir.name}`);
      }
    }

    const filterRow = container.createDiv({ cls: 'tn-mail-flex tn-mail-flex-wrap tn-mail-mb-8' });

    let dateFilterTimeout: number | null = null;

    filterRow.createSpan({ text: 'Дата:', cls: 'tn-mail-meta' });
    const dateFromInput = filterRow.createEl('input', { attr: { type: 'date' }, cls: 'tn-mail-date' });
    dateFromInput.value = this.filterDateFrom;
    dateFromInput.addEventListener('input', () => {
      this.filterDateFrom = dateFromInput.value;
      if (dateFilterTimeout) window.clearTimeout(dateFilterTimeout);
      dateFilterTimeout = window.setTimeout(() => this.renderView(), 1000);
    });
    filterRow.createSpan({ text: '—', cls: 'tn-mail-meta' });
    const dateToInput = filterRow.createEl('input', { attr: { type: 'date' }, cls: 'tn-mail-date' });
    dateToInput.value = this.filterDateTo;
    dateToInput.addEventListener('input', () => {
      this.filterDateTo = dateToInput.value;
      if (dateFilterTimeout) window.clearTimeout(dateFilterTimeout);
      dateFilterTimeout = window.setTimeout(() => this.renderView(), 1000);
    });

    filterRow.createSpan({ text: 'Автор:', cls: 'tn-mail-meta' });
    const authorSelect = filterRow.createEl('select', { cls: 'tn-mail-select' });
    const allAuthors = [...new Set(this.plugin.mailDb.getAllEmails().map(e => e.author).filter(Boolean))].sort();
    authorSelect.createEl('option', { value: '', text: '— все —' });
    for (const a of allAuthors) {
      authorSelect.createEl('option', { value: a, text: a });
    }
    authorSelect.value = this.filterAuthor;
    authorSelect.addEventListener('change', () => {
      this.filterAuthor = authorSelect.value;
      this.renderView();
    });

    const emails = this.plugin.mailDb.getAllEmails();
    const q = this.searchQuery.trim().toLowerCase();
    let filtered = emails;
    if (q) {
      filtered = emails.filter(e =>
        e.number.toLowerCase().includes(q) ||
        e.subject.toLowerCase().includes(q) ||
        e.text.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q)
      );
    }
    if (this.selectedDirectionIds.size > 0) {
      filtered = filtered.filter(e => this.selectedDirectionIds.has(e.direction_id));
    }
    if (this.filterDateFrom) {
      const from = new Date(this.filterDateFrom);
      from.setHours(0, 0, 0, 0);
      filtered = filtered.filter(e => new Date(e.date) >= from);
    }
    if (this.filterDateTo) {
      const to = new Date(this.filterDateTo);
      to.setHours(23, 59, 59, 999);
      filtered = filtered.filter(e => new Date(e.date) <= to);
    }
    if (this.filterAuthor) {
      filtered = filtered.filter(e => e.author === this.filterAuthor);
    }

    filtered.sort((a, b) => b.id - a.id);

    const table = container.createEl('table', { cls: 'tn-table' });

    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    const headers = ['№ п/п', 'Номер письма', 'Дата письма', 'Тема письма', 'Направление', 'Автор'];
    for (const h of headers) {
      const th = headerRow.createEl('th');
      th.setText(h);
    }

    const tbody = table.createEl('tbody');

    if (filtered.length === 0) {
      const emptyRow = tbody.createEl('tr');
      const td = emptyRow.createEl('td', { cls: 'tn-mail-center tn-mail-p24' });
      td.setAttr('colspan', '6');
      td.setText('Нет писем');
      return;
    }

    for (let i = 0; i < filtered.length; i++) {
      const email = filtered[i];
      const row = tbody.createEl('tr', { cls: 'tn-mail-row' });
      row.addEventListener('click', () => this.renderEmailDetail(email));

      const numCell = row.createEl('td');
      numCell.setText(String(i + 1));

      const numberCell = row.createEl('td');
      numberCell.setText(email.number);

      const dateCell = row.createEl('td');
      dateCell.setText(new Date(email.date).toLocaleDateString());

      const subjectCell = row.createEl('td');
      subjectCell.setText(email.subject);

      const dirCell = row.createEl('td');
      dirCell.setText(email.direction_name || this.plugin.mailDb.getDirectionName(email.direction_id) || '—');

      const authorCell = row.createEl('td');
      authorCell.setText(email.author);
    }
  }

  private renderEmailDetail(email: MailItem): void {
    const container = this.containerElContent;
    container.empty();
    this.createViewActive = true;

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderView());

    container.createEl('h3', { text: `${email.number} — ${email.subject}` });

    const metaDiv = container.createDiv({ cls: 'tn-mail-meta tn-mail-mb12' });
    const dirName = email.direction_name || this.plugin.mailDb.getDirectionName(email.direction_id);
    metaDiv.createDiv({ text: `Автор: ${email.author}` });
    metaDiv.createDiv({ text: `Дата: ${new Date(email.date).toLocaleString()}` });
    metaDiv.createDiv({ text: `Направление: ${dirName}` });
    metaDiv.createDiv({ text: `Статус: ${email.sync_status === 'synced' ? '☁️ Синхронизировано' : '📝 Локально'}` });

    container.createEl('h4', { text: 'Содержимое письма' });
    const textDiv = container.createDiv({ cls: 'tn-mail-text' });
    textDiv.setText(email.text);

    const btnRow = container.createDiv({ cls: 'tn-mail-header tn-mail-mt12' });

    const editBtn = btnRow.createEl('button', { text: '✏️ Редактировать', cls: 'tn-btn tn-btn-ghost' });
    editBtn.addEventListener('click', () => this.showEditForm(email));

    const exportBtn = btnRow.createEl('button', { text: '📥 Экспорт в Word', cls: 'tn-btn tn-btn-ghost' });
    exportBtn.addEventListener('click', async () => {
      exportBtn.setText('⏳');
      exportBtn.setAttr('disabled', 'true');
      try {
        const svc = new DocumentService(this.plugin.app);
        await svc.exportToDocx(
          {
            number: email.number,
            subject: email.subject,
            text: email.text,
            date: email.date,
            author: email.author,
            images: email.images,
          },
          this.plugin.settings.docxTemplatePath,
          this.plugin.settings.docxExportFolder,
        );
      } catch (e: unknown) {
        console.warn('Письма: экспорт в Word не удался:', errorMessage(e));
      } finally {
        exportBtn.setText('📥 Экспорт в Word');
        exportBtn.removeAttribute('disabled');
      }
    });

    if (email.images && email.images.length > 0) {
      container.createEl('h4', { text: 'Прикреплённые файлы' });
      const filesDiv = container.createDiv({ cls: 'tn-mail-files' });
      for (const url of email.images) {
        const name = url.split('/').pop() || url;
        const tag = filesDiv.createEl('span', { cls: 'tn-mail-file' });
        tag.setText(`📎 ${name}`);
      }
    }
  }

  private showEditForm(email: MailItem): void {
    const container = this.containerElContent;
    container.empty();
    this.createViewActive = true;

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderEmailDetail(email));

    container.createEl('h3', { text: `✏️ Редактировать письмо ${email.number}` });

    const numberLabel = container.createEl('label', { text: 'Исходящий номер', cls: 'tn-mail-label' });
    const numberInput = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-mail-input' });
    numberInput.value = email.number;

    const subjectLabel = container.createEl('label', { text: 'Тема письма', cls: 'tn-mail-label' });
    const subjectInput = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-mail-input' });
    subjectInput.value = email.subject;

    const textLabel = container.createEl('label', { text: 'Содержимое письма', cls: 'tn-mail-label' });
    const textInput = container.createEl('textarea', { cls: 'tn-mail-textarea' });
    textInput.value = email.text;

    const filesLabel = container.createEl('label', { text: 'Прикреплённые файлы', cls: 'tn-mail-label' });
    const filesDiv = container.createDiv({ cls: 'tn-mail-mb-8' });

    const fileInput = container.createEl('input', { attr: { type: 'file', multiple: 'true' }, cls: 'tn-mail-hidden' });
    const attachBtn = filesDiv.createEl('button', { text: '📎 Прикрепить файл', cls: 'tn-btn tn-btn-ghost' });
    attachBtn.addEventListener('click', () => fileInput.click());

    const attachedFiles: string[] = [...email.images];
    const fileListDiv = filesDiv.createDiv({ cls: 'tn-mail-files' });
    const renderFiles = () => {
      this.renderAttachedFiles(fileListDiv, attachedFiles, (idx) => {
        attachedFiles.splice(idx, 1);
        renderFiles();
      });
    };
    renderFiles();

    fileInput.addEventListener('change', (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      for (const file of Array.from(files)) {
        attachedFiles.push(file.name);
        new Notice(`📎 Файл добавлен локально: ${file.name}`);
      }
      renderFiles();
      fileInput.value = '';
    });

    const dirLabel = container.createEl('label', { text: 'Направление', cls: 'tn-mail-label' });
    const dirInput = container.createEl('input', {
      attr: { type: 'text', list: 'tn-mail-dirs' },
      cls: 'tn-mail-input',
    });
    const currentDirName = email.direction_name || this.plugin.mailDb.getDirectionName(email.direction_id);
    dirInput.value = currentDirName;
    this.renderDirDatalist(dirInput);

    const dirRow = container.createDiv({ cls: 'tn-mail-flex tn-mail-mb12' });
    const addDirBtn = dirRow.createEl('button', { text: '➕ Создать направление', cls: 'tn-btn tn-btn-ghost' });
    addDirBtn.addEventListener('click', () => this.createDirectionFromField(dirInput));

    const btnRow = container.createDiv({ cls: 'tn-mail-header tn-mail-mt12' });

    const saveBtn = btnRow.createEl('button', { text: '💾 Сохранить изменения', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.renderEmailDetail(email));

    saveBtn.addEventListener('click', async () => {
      const number = numberInput.value.trim();
      const subject = subjectInput.value.trim();
      const text = textInput.value.trim();
      const dirName = dirInput.value.trim();

      if (!number || !subject || !text) {
        new Notice('Заполните все поля'); return;
      }

      saveBtn.setText('⏳');
      saveBtn.setAttr('disabled', 'true');
      cancelBtn.setAttr('disabled', 'true');

      const now = new Date().toISOString();
      const directionId = this.plugin.mailDb.resolveDirectionId(dirName);

      email.number = number;
      email.subject = subject;
      email.text = text;
      email.direction_id = directionId;
      email.direction_name = dirName;
      email.images = attachedFiles;
      email.lastSyncTime = now;
      email.updated_at = now;
      email.sync_status = 'local';
      this.plugin.mailDb.addEmail(email);
      await this.plugin.mailDb.save();
      new Notice('Письмо сохранено (будет отправлено на сервер при синхронизации)');
      this.renderEmailDetail(email);
    });
  }

  private showCreateForm(initialSubject = '', initialText = ''): void {
    const container = this.containerElContent;
    container.empty();
    this.createViewActive = true;

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderView());

    container.createEl('h3', { text: '✉️ Новое письмо' });

    const numberLabel = container.createEl('label', { text: 'Исходящий номер', cls: 'tn-mail-label' });
    const numberInput = container.createEl('input', { attr: { type: 'text', placeholder: 'Например: 009' }, cls: 'tn-mail-input' });

    const subjectLabel = container.createEl('label', { text: 'Тема письма', cls: 'tn-mail-label' });
    const subjectInput = container.createEl('input', { attr: { type: 'text', placeholder: 'Тема' }, cls: 'tn-mail-input' });
    subjectInput.value = initialSubject;

    const textLabel = container.createEl('label', { text: 'Содержимое письма', cls: 'tn-mail-label' });
    const textInput = container.createEl('textarea', { cls: 'tn-mail-textarea' });
    textInput.value = initialText;

    const aiDiv = container.createDiv({ cls: 'tn-mail-mt12 tn-mail-flex tn-mail-flex-wrap' });
    const aiInput = container.createEl('input', {
      attr: { type: 'text', placeholder: 'Опишите запрос для черновика: «ответ клиенту про ПВХ-мембраны на кровле»' },
      cls: 'tn-mail-input tn-mail-mb8',
    });
    aiDiv.appendChild(aiInput);
    const aiBtn = container.createEl('button', { text: '✨ Сгенерировать черновик (AI)', cls: 'tn-btn tn-btn-primary' });
    aiDiv.appendChild(aiBtn);

    aiBtn.addEventListener('click', async () => {
      const request = aiInput.value.trim();
      if (!request) {
        new Notice('Опишите, что нужно написать');
        return;
      }
      aiBtn.setText('⏳ Поиск и генерация…');
      aiBtn.setAttr('disabled', 'true');
      try {
        const draft = await this.plugin.llmGenerator.generateDraft(request);
        subjectInput.value = draft.subject;
        textInput.value = draft.text;
        new Notice(`AI: черновик готов (на основе ${draft.sourceCount} писем локальной базы)`);
      } catch (e: unknown) {
        new Notice(`Письма: генерация не удалась — ${errorMessage(e)}`);
      } finally {
        aiBtn.setAttr('disabled', null);
        aiBtn.setText('✨ Сгенерировать черновик (AI)');
      }
    });

    const filesLabel = container.createEl('label', { text: 'Прикреплённые файлы', cls: 'tn-mail-label' });
    const filesDiv = container.createDiv({ cls: 'tn-mail-mb-8' });

    const fileInput = container.createEl('input', { attr: { type: 'file', multiple: 'true' }, cls: 'tn-mail-hidden' });
    const attachBtn = filesDiv.createEl('button', { text: '📎 Прикрепить файл', cls: 'tn-btn tn-btn-ghost' });
    attachBtn.addEventListener('click', () => fileInput.click());

    const attachedFiles: string[] = [];
    const fileListDiv = filesDiv.createDiv({ cls: 'tn-mail-files' });
    const renderFiles = () => {
      this.renderAttachedFiles(fileListDiv, attachedFiles, (idx) => {
        attachedFiles.splice(idx, 1);
        renderFiles();
      });
    };
    renderFiles();

    fileInput.addEventListener('change', (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      for (const file of Array.from(files)) {
        attachedFiles.push(file.name);
        new Notice(`📎 Файл добавлен локально: ${file.name}`);
      }
      renderFiles();
      fileInput.value = '';
    });

    const dirLabel = container.createEl('label', { text: 'Направление', cls: 'tn-mail-label' });
    const dirInput = container.createEl('input', {
      attr: { type: 'text', list: 'tn-mail-dirs' },
      cls: 'tn-mail-input',
    });
    this.renderDirDatalist(dirInput);

    const dirRow = container.createDiv({ cls: 'tn-mail-flex tn-mail-mb12' });
    const addDirBtn = dirRow.createEl('button', { text: '➕ Создать направление', cls: 'tn-btn tn-btn-ghost' });
    addDirBtn.addEventListener('click', () => this.createDirectionFromField(dirInput));

    const btnRow = container.createDiv({ cls: 'tn-mail-header tn-mail-mt12' });

    const saveBtn = btnRow.createEl('button', { text: '💾 Сохранить', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.renderView());

    saveBtn.addEventListener('click', async () => {
      const number = numberInput.value.trim();
      const subject = subjectInput.value.trim();
      const text = textInput.value.trim();
      const dirName = dirInput.value.trim();

      if (!number || !subject || !text) {
        new Notice('Заполните все поля'); return;
      }

      saveBtn.setText('⏳');
      saveBtn.setAttr('disabled', 'true');
      cancelBtn.setAttr('disabled', 'true');

      const now = new Date().toISOString();
      const emailId = Date.now() + Math.floor(Math.random() * 1000);
      const author = this.plugin.settings.defaultAuthor || 'И.И. Иванов';
      const directionId = this.plugin.mailDb.resolveDirectionId(dirName);

      const emailItem: MailItem = {
        id: emailId,
        number,
        subject,
        text,
        author,
        date: now,
        direction_id: directionId,
        direction_name: dirName,
        images: attachedFiles,
        mdFilePath: '',
        mdFileHash: '',
        lastSyncTime: now,
        sync_status: 'local',
        created_at: now,
        updated_at: now,
      };

      this.plugin.mailDb.addEmail(emailItem);
      await this.plugin.mailDb.save();
      new Notice('Письмо сохранено (будет отправлено на сервер при синхронизации)');
      this.renderView();
    });
  }

  private renderDirDatalist(input: HTMLElement): void {
    const list = input.getAttr('list') || 'tn-mail-dirs';
    const existing = document.getElementById(list);
    if (existing) existing.remove();
    const datalist = document.createElement('datalist');
    datalist.id = list;
    for (const d of this.plugin.mailDb.getDirections()) {
      datalist.createEl('option', { value: d.name });
    }
    document.body.appendChild(datalist);
  }

  /** Создаёт направление из введённого имени (если ещё нет) и обновляет datalist. */
  private async createDirectionFromField(dirInput: HTMLInputElement): Promise<void> {
    const name = dirInput.value.trim();
    if (!name) {
      new Notice('Введите название направления');
      dirInput.focus();
      return;
    }
    const existing = this.plugin.mailDb.getDirections().find(d => d.name === name);
    if (existing) {
      new Notice(`Направление «${name}» уже существует`);
      return;
    }
    this.plugin.mailDb.addDirection({
      id: Date.now() + Math.floor(Math.random() * 100),
      name,
      description: '',
      created_at: new Date().toISOString(),
    });
    await this.plugin.mailDb.save();
    this.renderDirDatalist(dirInput);
    new Notice(`Направление «${name}» создано`);
  }

  private renderAttachedFiles(container: HTMLElement, files: string[], onRemove?: (index: number) => void): void {
    container.empty();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const tag = container.createEl('span', { cls: 'tn-mail-file' });
      tag.setText(`📎 ${f}`);
      if (onRemove) {
        const removeBtn = tag.createEl('span', { cls: 'tn-mail-file-remove' });
        removeBtn.setText(' ×');
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          onRemove(i);
        });
      }
    }
  }

  private async exportHtml(): Promise<void> {
    const emails = this.plugin.mailDb.getAllEmails();
    const q = this.searchQuery.trim().toLowerCase();
    let filtered = emails;
    if (q) {
      filtered = emails.filter(e =>
        e.number.toLowerCase().includes(q) ||
        e.subject.toLowerCase().includes(q) ||
        e.text.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q)
      );
    }
    if (this.selectedDirectionIds.size > 0) {
      filtered = filtered.filter(e => this.selectedDirectionIds.has(e.direction_id));
    }
    if (this.filterDateFrom) {
      const from = new Date(this.filterDateFrom);
      from.setHours(0, 0, 0, 0);
      filtered = filtered.filter(e => new Date(e.date) >= from);
    }
    if (this.filterDateTo) {
      const to = new Date(this.filterDateTo);
      to.setHours(23, 59, 59, 999);
      filtered = filtered.filter(e => new Date(e.date) <= to);
    }
    if (this.filterAuthor) {
      filtered = filtered.filter(e => e.author === this.filterAuthor);
    }
    filtered.sort((a, b) => b.id - a.id);

    let html = '';
    for (const e of filtered) {
      const d = new Date(e.date);
      const dateStr = d.toLocaleDateString('ru-RU');
      const numDate = `${e.number} от ${dateStr}`;
      const attachments = (e.images || []).map(url => url.split('/').pop() || url).join('; ');
      html += `<tr>
<td style="text-align: center;">${this.escapeHtml(numDate)}</td>
<td style="text-align: center;">${this.escapeHtml(attachments)}</td>
<td style="text-align: center;"><h1 style="font-weight: normal; font-size: 12pt;">${this.escapeHtml(e.subject)}</h1></td>
<td style="text-align: center;"></td>
</tr>\n`;
    }

    try {
      await navigator.clipboard.writeText(html);
      new Notice(`✅ Скопировано ${filtered.length} строк в буфер обмена`);
    } catch (e: unknown) {
      new Notice(`❌ Не удалось скопировать в буфер: ${errorMessage(e)}`);
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async syncAndRender(): Promise<void> {
    try {
      await this.plugin.syncService.sync();
      this.renderView();
    } catch (e: unknown) {
      new Notice(`Письма: синхронизация не выполнена — ${errorMessage(e)}`);
      this.renderView();
    }
  }
}