import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type SbeMailPlugin from '../main';
import type { MailItem } from '../types/mail';
import { DocumentService } from '../services/document-service';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

export const SBE_MAIL_VIEW_TYPE = 'sbe-mail-view';

type NavKey = 'mails';

const PAGE_META: Record<NavKey, { title: string; sub: string }> = {
  mails: { title: 'Все письма', sub: 'Реестр исходящих писем' },
};

export class MailView extends ItemView {
  plugin: SbeMailPlugin;
  private rootEl!: HTMLElement;
  private navEl!: HTMLElement;
  private filtersEl!: HTMLElement;
  private pageTitleEl!: HTMLElement;
  private pageSubEl!: HTMLElement;
  private crumbEl!: HTMLElement;
  private collapseLabel!: HTMLElement;
  private bodyEl!: HTMLElement;
  private key: NavKey = 'mails';
  private collapsed = false;
  private selectedDirectionIds: Set<number> = new Set();
  private searchQuery = '';
  private searchTimeout: number | null = null;
  private filterDateFrom = '';
  private filterDateTo = '';
  private filterAuthor = '';
  private myRole = '';

  constructor(leaf: WorkspaceLeaf, plugin: SbeMailPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SBE_MAIL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'LogicTEAM.Письма';
  }

  getIcon(): string {
    return 'mail';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.addClass('tn-mail-container');
    this.rootEl = container.createDiv({ cls: 'tn-mail-app' });

    this.selectedDirectionIds = new Set(this.plugin.settings.selectedDirectionIds);
    try {
      const me = await this.plugin.syncService.getMyPermission();
      this.myRole = me.hasAccess ? me.role : '';
    } catch (e: unknown) {
      console.warn('Письма: не удалось получить роль:', errorMessage(e));
      this.myRole = '';
    }

    this.buildShell();
    this.syncNavActive();
    this.renderPage();
  }

  refresh(): void {
    this.renderPage();
  }

  // ---- Каркас ----

  private buildShell(): void {
    // шапка
    const topbar = this.rootEl.createDiv({ cls: 'tn-mail-topbar' });
    topbar.createDiv({ cls: 'tn-mail-module-title', text: 'LogicTEAM.Письма' });
    this.crumbEl = topbar.createDiv({ cls: 'tn-mail-crumb' });
    const spacer = topbar.createDiv({ cls: 'tn-mail-spacer' });
    spacer.empty();
    if (this.canEdit) {
      const createBtn = topbar.createEl('button', { text: '＋ Новое письмо', cls: 'tn-mail-create' });
      createBtn.addEventListener('click', () => this.showCreateForm());
    }

    // главная область: сайдбар + контент
    const main = this.rootEl.createDiv({ cls: 'tn-mail-main' });

    const sidebar = main.createDiv({ cls: 'tn-mail-sidebar' });

    // сворачивание
    const collapseBtn = sidebar.createDiv({ cls: 'tn-mail-collapse' });
    collapseBtn.createSpan({ text: '▧' });
    this.collapseLabel = collapseBtn.createSpan({ cls: 'tn-mail-collapse-lbl', text: 'Свернуть' });
    collapseBtn.addEventListener('click', () => this.toggleCollapse());

    // дерево навигации + фильтры по направлениям
    this.navEl = sidebar.createDiv({ cls: 'tn-mail-nav' });
    this.buildNav();

    // панель управления: синхронизация и экспорт HTML
    const actions = sidebar.createDiv({ cls: 'tn-mail-sidebar-actions' });
    const syncBtn = actions.createEl('button', { cls: 'tn-mail-nav-action' });
    syncBtn.createSpan({ text: '🔄' });
    syncBtn.createSpan({ cls: 'tn-mail-nav-lbl', text: 'Синхронизация' });
    syncBtn.addEventListener('click', () => { void this.syncAndRender(); });
    const exportBtn = actions.createEl('button', { cls: 'tn-mail-nav-action' });
    exportBtn.createSpan({ text: '📄' });
    exportBtn.createSpan({ cls: 'tn-mail-nav-lbl', text: 'Экспорт HTML' });
    exportBtn.addEventListener('click', () => { void this.exportHtml(); });

    const content = main.createDiv({ cls: 'tn-mail-content' });
    this.pageTitleEl = content.createEl('h1', { cls: 'tn-mail-page-title' });
    this.pageSubEl = content.createDiv({ cls: 'tn-mail-page-sub' });
    this.bodyEl = content.createDiv();
  }

  private buildNav(): void {
    this.navEl.empty();

    // Группа «Письма»
    const mailGroup = this.navEl.createEl('button', { cls: 'tn-mail-grp' });
    mailGroup.createSpan({ cls: 'tn-mail-grp-ico', text: '📧' });
    mailGroup.createSpan({ cls: 'tn-mail-grp-lbl', text: 'Письма' });
    mailGroup.createSpan({ cls: 'tn-mail-grp-chev', text: '▶' });
    mailGroup.addEventListener('click', () => {
      mailGroup.classList.toggle('open');
      mailGroup.classList.toggle('active');
    });
    const mailSubmenu = this.navEl.createDiv({ cls: 'tn-mail-submenu' });
    const allMails = mailSubmenu.createEl('a', { cls: 'tn-mail-nav-item', attr: { href: '#' } });
    allMails.createSpan({ cls: 'tn-mail-nav-lbl', text: 'Все письма' });
    allMails.dataset.key = 'mails';
    allMails.addEventListener('click', (ev) => {
      ev.preventDefault();
      this.key = 'mails';
      this.syncNavActive();
      this.renderPage();
    });
    mailGroup.classList.add('open', 'active');

    // Группа «Фильтры» — чекбоксы направлений
    const filterGroup = this.navEl.createEl('button', { cls: 'tn-mail-grp' });
    filterGroup.createSpan({ cls: 'tn-mail-grp-ico', text: '🔍' });
    filterGroup.createSpan({ cls: 'tn-mail-grp-lbl', text: 'Фильтры' });
    filterGroup.createSpan({ cls: 'tn-mail-grp-chev', text: '▶' });
    filterGroup.addEventListener('click', () => {
      filterGroup.classList.toggle('open');
      filterGroup.classList.toggle('active');
    });
    this.filtersEl = this.navEl.createDiv({ cls: 'tn-mail-submenu tn-mail-filters-nav' });
    filterGroup.classList.add('open');
    this.renderSidebarFilters();

    this.syncNavActive();
  }

  /** Чекбоксы фильтров по направлениям (в группе «Фильтры» сайдбара). */
  private renderSidebarFilters(): void {
    if (!this.filtersEl) return;
    this.filtersEl.empty();
    const directions = this.plugin.mailDb.getDirections();
    if (directions.length === 0) {
      this.filtersEl.createDiv({ cls: 'tn-mail-nav-empty' }).setText('Направлений пока нет');
      return;
    }
    for (const dir of directions) {
      const wrapper = this.filtersEl.createEl('label', { cls: 'tn-mail-filter-label tn-mail-sidebar-filter' });
      const cb = wrapper.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-mail-cb' });
      cb.checked = this.selectedDirectionIds.has(dir.id);
      cb.addEventListener('change', () => {
        if (cb.checked) this.selectedDirectionIds.add(dir.id);
        else this.selectedDirectionIds.delete(dir.id);
        this.plugin.settings.selectedDirectionIds = [...this.selectedDirectionIds];
        void this.plugin.saveSettings();
        this.renderPage();
      });
      wrapper.createEl('span').setText(dir.name);
    }
  }

  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.rootEl.classList.toggle('collapsed', this.collapsed);
    if (this.collapseLabel) {
      this.collapseLabel.setText(this.collapsed ? 'Развернуть' : 'Свернуть');
    }
  }

  private syncNavActive(): void {
    this.navEl.querySelectorAll('.tn-mail-nav-item').forEach((el) => {
      const navEl = el as HTMLElement;
      navEl.classList.toggle('active', navEl.dataset.key === this.key);
    });
  }

  // ---- Страница ----

  private renderPage(): void {
    const meta = PAGE_META[this.key];
    this.crumbEl.setText(meta.title);
    this.pageTitleEl.setText(meta.title);
    this.pageSubEl.setText(meta.sub);

    this.bodyEl.empty();
    this.renderEmailsView();
  }

  /** Роль editor/admin — можно создавать/редактировать письма. */
  private get canEdit(): boolean {
    return this.myRole === 'editor' || this.myRole === 'admin';
  }

  /** Роль admin — можно удалять письма из базы. */
  private get canDelete(): boolean {
    return this.myRole === 'admin';
  }

  // ---- Список писем ----

  private renderEmailsView(): void {
    const container = this.bodyEl;
    container.empty();

    const searchInput = container.createEl('input', {
      attr: { type: 'text', placeholder: '🔍 Поиск по номеру, теме, тексту...' },
      cls: 'tn-mail-input tn-mail-mb-8',
    });
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      if (this.searchTimeout) window.clearTimeout(this.searchTimeout);
      this.searchTimeout = window.setTimeout(() => this.renderEmailsView(), 500);
    });

    const filterRow = container.createDiv({ cls: 'tn-mail-flex tn-mail-flex-wrap tn-mail-mb-8' });

    let dateFilterTimeout: number | null = null;

    filterRow.createSpan({ text: 'Дата:', cls: 'tn-mail-meta' });
    const dateFromInput = filterRow.createEl('input', { attr: { type: 'date' }, cls: 'tn-mail-date' });
    dateFromInput.value = this.filterDateFrom;
    dateFromInput.addEventListener('input', () => {
      this.filterDateFrom = dateFromInput.value;
      if (dateFilterTimeout) window.clearTimeout(dateFilterTimeout);
      dateFilterTimeout = window.setTimeout(() => this.renderEmailsView(), 1000);
    });
    filterRow.createSpan({ text: '—', cls: 'tn-mail-meta' });
    const dateToInput = filterRow.createEl('input', { attr: { type: 'date' }, cls: 'tn-mail-date' });
    dateToInput.value = this.filterDateTo;
    dateToInput.addEventListener('input', () => {
      this.filterDateTo = dateToInput.value;
      if (dateFilterTimeout) window.clearTimeout(dateFilterTimeout);
      dateFilterTimeout = window.setTimeout(() => this.renderEmailsView(), 1000);
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
      this.renderEmailsView();
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

    filtered.sort((a, b) => this.compareDatesDesc(a.date, b.date));

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

  // ---- Детали письма ----

  private renderEmailDetail(email: MailItem): void {
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderEmailsView());

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

    if (this.canEdit) {
      const editBtn = btnRow.createEl('button', { text: '✏️ Редактировать', cls: 'tn-btn tn-btn-ghost' });
      editBtn.addEventListener('click', () => this.showEditForm(email));
    }

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
          {
            position: this.plugin.settings.position,
            degree: this.plugin.settings.degree,
            rank: this.plugin.settings.rank,
            phone: this.plugin.settings.phone,
            email: this.plugin.settings.email,
          },
        );
      } catch (e: unknown) {
        console.warn('Письма: экспорт в Word не удался:', errorMessage(e));
      } finally {
        exportBtn.setText('📥 Экспорт в Word');
        exportBtn.removeAttribute('disabled');
      }
    });

    if (this.canDelete) {
      const deleteBtn = btnRow.createEl('button', { text: '🗑 Удалить письмо', cls: 'tn-btn tn-btn-ghost' });
      deleteBtn.addEventListener('click', async () => {
        const confirmed = window.confirm(`Удалить письмо «${email.number} — ${email.subject}» из базы? Это действие нельзя отменить.`);
        if (!confirmed) return;
        deleteBtn.setText('⏳');
        deleteBtn.setAttr('disabled', 'true');
        try {
          await this.plugin.syncService.deleteEmail(email.id);
          this.plugin.mailDb.deleteEmail(email.id);
          await this.plugin.mailDb.save();
          new Notice('Письмо удалено');
          this.renderEmailsView();
        } catch (e: unknown) {
          new Notice(`Письма: не удалось удалить — ${errorMessage(e)}`);
          deleteBtn.setText('🗑 Удалить письмо');
          deleteBtn.removeAttribute('disabled');
        }
      });
    }

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

  // ---- Формы ----

  private showEditForm(email: MailItem): void {
    const container = this.bodyEl;
    container.empty();

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
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderEmailsView());

    container.createEl('h3', { text: '✉️ Новое письмо' });

    const dirLabel = container.createEl('label', { text: 'Направление', cls: 'tn-mail-label' });
    const dirInput = container.createEl('input', {
      attr: { type: 'text', list: 'tn-mail-dirs' },
      cls: 'tn-mail-input',
    });
    this.renderDirDatalist(dirInput);

    const dirRow = container.createDiv({ cls: 'tn-mail-flex tn-mail-mb12' });
    const addDirBtn = dirRow.createEl('button', { text: '➕ Создать направление', cls: 'tn-btn tn-btn-ghost' });
    addDirBtn.addEventListener('click', () => this.createDirectionFromField(dirInput));

    const numberLabel = container.createEl('label', { text: 'Исходящий номер', cls: 'tn-mail-label' });
    const numberHint = container.createDiv({ cls: 'tn-mail-meta tn-mail-mb-8', text: 'Автоматически подставляется Номер последнего известного письма по выбранному направлению, не забудьте изменить' });
    const numberInput = container.createEl('input', { attr: { type: 'text', placeholder: 'Например: 009' }, cls: 'tn-mail-input' });

    // При выборе направления подставляем номер последнего письма этого направления.
    dirInput.addEventListener('change', () => {
      const dirName = dirInput.value.trim();
      if (!dirName) return;
      const dirId = this.plugin.mailDb.getDirections().find(d => d.name === dirName)?.id;
      if (dirId === undefined) return;
      const last = this.plugin.mailDb.getAllEmails()
        .filter(e => e.direction_id === dirId && e.number && e.number.trim() !== '')
        .sort((a, b) => this.compareDatesDesc(a.date, b.date))[0];
      if (last && last.number) {
        numberInput.value = last.number;
      }
    });

    const subjectLabel = container.createEl('label', { text: 'Тема письма', cls: 'tn-mail-label' });
    const subjectInput = container.createEl('input', { attr: { type: 'text', placeholder: 'Тема' }, cls: 'tn-mail-input' });
    subjectInput.value = initialSubject;

    const textLabel = container.createEl('label', { text: 'Содержимое письма', cls: 'tn-mail-label' });
    const textInput = container.createEl('textarea', { cls: 'tn-mail-textarea' });
    textInput.value = initialText;

    const aiDiv = container.createDiv({ cls: 'tn-mail-mt12 tn-mail-flex tn-mail-flex-wrap' });
    const aiInput = container.createEl('input', {
      attr: { type: 'text', placeholder: 'Опишите запрос для черновика: «ответ клиенту про ПВХ-мембраны на кровле»' },
      cls: 'tn-mail-input tn-mail-mb-8',
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

    const btnRow = container.createDiv({ cls: 'tn-mail-header tn-mail-mt12' });

    const saveBtn = btnRow.createEl('button', { text: '💾 Сохранить', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.renderEmailsView());

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
      this.renderEmailsView();
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
    this.renderSidebarFilters();
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
    filtered.sort((a, b) => this.compareDatesDesc(a.date, b.date));

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

  /** Сравнение по дате письма: сначала новые (desc). Невалидные даты — в конец. */
  private compareDatesDesc(a: string, b: string): number {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  }

  async syncAndRender(): Promise<void> {
    try {
      await this.plugin.syncService.sync();
      this.renderSidebarFilters();
      this.renderEmailsView();
    } catch (e: unknown) {
      new Notice(`Письма: синхронизация не выполнена — ${errorMessage(e)}`);
      this.renderEmailsView();
    }
  }
}
