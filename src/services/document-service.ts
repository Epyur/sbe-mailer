import { App, FileSystemAdapter, Notice } from 'obsidian';
import JSZip from 'jszip';
import { Document, Packer, Paragraph, TextRun, ImageRun } from 'docx';

interface EmailData {
  number?: string;
  subject?: string;
  text?: string;
  date?: string;
  author?: string;
  images?: string[];
}

interface SignatureData {
  position: string;
  degree: string;
  rank: string;
  phone: string;
  email: string;
}

interface TemplateData {
  number: string;
  subject: string;
  textForWord: string;
  author: string;
  date: string;
  year: string;
  month: string;
  day: string;
  time: string;
  position: string;
  phone: string;
  email: string;
}

/** Экспорт письма в DOCX: шаблон с плейсхолдерами или fallback-генерация. */
export class DocumentService {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  private sanitizeFileName(name: string): string {
    if (!name) return 'без_названия';
    return name.replace(/[\\/:*?"<>|/]/g, '_').replace(/_+/g, '_').trim();
  }

  private escapeXml(text: string): string {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private formatTextForWord(text: string): string {
    if (!text) return '';
    const lines = text.split('\n');
    const result: string[] = [];
    for (const line of lines) {
      if (line.trim() === '') {
        result.push('<br>');
      } else {
        result.push(this.escapeXml(line));
      }
    }
    return result.join('<br>');
  }

  private formatTextForDocxXml(text: string): string {
    if (!text) return '';
    const lines = text.split('\n');
    const result: string[] = [];
    for (const line of lines) {
      if (line.trim() === '') {
        result.push('<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p>');
      } else {
        result.push(`<w:p><w:r><w:t>${this.escapeXml(line)}</w:t></w:r></w:p>`);
      }
    }
    return result.join('');
  }

  /** Подстановка текстовых плейсхолдеров в document.xml. Word разбивает один
   *  плейсхолдер на несколько <w:r>/<w:t> (например "{{Должность}}" = "{{"+...),
   *  поэтому замена выполняется по объединённому тексту всех <w:t> с последующей
   *  пересборкой XML: значение кладётся в первый run плейсхолдера, остальные чистятся. */
  private replacePlaceholdersAcrossRuns(xml: string, replacements: Record<string, string>): string {
    // Разбиваем XML на элементы <w:t>...</w:t> и запоминаем их содержимое и позиции.
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    const segments: Array<{ start: number; end: number; text: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = tRe.exec(xml)) !== null) {
      segments.push({
        start: m.index,
        end: m.index + m[0].length,
        text: m[1],
      });
    }
    if (segments.length === 0) return xml;

    // Собираем единый "логический текст" из всех <w:t> в порядке документа
    // и карту: смещение в логическом тексте -> (индекс сегмента, смещение внутри).
    let logical = '';
    const segStarts: number[] = [];
    for (const seg of segments) {
      segStarts.push(logical.length);
      logical += seg.text;
    }
    const logicalEnds = segments.map((seg, i) => segStarts[i] + seg.text.length);

    // Ищем плейсхолдеры {{...}} в логическом тексте и готовим правки по сегментам.
    const newTexts = segments.map(s => s.text);
    const phRe = /\{\{([^{}]*)\}\}/g;
    let pm: RegExpExecArray | null;
    while ((pm = phRe.exec(logical)) !== null) {
      const token = pm[0];
      const value = replacements[token];
      if (value === undefined) continue;
      const phStart = pm.index;
      const phEnd = pm.index + token.length;

      // Сегмент, в котором начинается плейсхолдер.
      const i = segments.findIndex((_, idx) => phStart >= segStarts[idx] && phStart < logicalEnds[idx]);
      let j = segments.findIndex((_, idx) => phEnd > segStarts[idx] && phEnd <= logicalEnds[idx]);
      if (phEnd === logical.length) {
        j = segments.length - 1;
      }
      if (i === -1 || j === -1 || i > j) continue;

      const startOffset = phStart - segStarts[i];
      const endOffset = phEnd - segStarts[j];

      if (i === j) {
        // Плейсхолдер в одном <w:t> — обычная замена подстроки.
        newTexts[i] = newTexts[i].slice(0, startOffset) + value + newTexts[i].slice(endOffset);
      } else {
        // Плейсхолдер разорван на несколько <w:t>: значение в первый сегмент,
        // промежуточные очищаем, в последнем оставляем текст после плейсхолдера.
        newTexts[i] = newTexts[i].slice(0, startOffset) + value;
        for (let k = i + 1; k < j; k++) newTexts[k] = '';
        newTexts[j] = newTexts[j].slice(endOffset);
      }
    }

    // Пересобираем XML, заменяя содержимое каждого <w:t> на изменённое.
    let result = '';
    let cursor = 0;
    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx];
      if (newTexts[idx] !== seg.text) {
        result += xml.slice(cursor, seg.start);
        const innerOpen = xml.indexOf('>', seg.start) + 1;
        const innerClose = xml.lastIndexOf('</w:t>', seg.end);
        result += xml.slice(seg.start, innerOpen) + newTexts[idx] + xml.slice(innerClose, seg.end);
        cursor = seg.end;
      } else {
        result += xml.slice(cursor, seg.end);
        cursor = seg.end;
      }
    }
    result += xml.slice(cursor);
    return result;
  }

  private async getImageSize(path: string): Promise<{ width: number; height: number }> {
    try {
      const adapter = this.app.vault.adapter;
      const data = await adapter.readBinary(path);
      const buffer = new Uint8Array(data);

      const ext = path.split('.').pop()?.toLowerCase() || 'png';

      if (ext === 'png') {
        return { width: this.readInt(buffer, 16), height: this.readInt(buffer, 20) };
      }
      if (ext === 'jpg' || ext === 'jpeg') {
        let offset = 2;
        while (offset < buffer.length) {
          if (buffer[offset] === 0xFF && buffer[offset + 1] === 0xC0 && buffer[offset + 2] === 0x00 && buffer[offset + 3] === 0x11) {
            const height = (buffer[offset + 5] << 8) + buffer[offset + 6];
            const width = (buffer[offset + 7] << 8) + buffer[offset + 8];
            return { width, height };
          }
          offset++;
        }
      }
      if (ext === 'bmp') {
        const width = this.readInt(buffer, 18);
        const height = Math.abs(this.readInt(buffer, 22));
        return { width, height };
      }
      if (ext === 'gif') {
        const width = (buffer[7] << 8) + buffer[6];
        const height = (buffer[9] << 8) + buffer[8];
        return { width, height };
      }
    } catch (e: unknown) {
      console.warn('Письма: не удалось определить размер изображения:', path, e);
    }
    return { width: 400, height: 300 };
  }

  private readInt(buffer: Uint8Array, offset: number): number {
    return ((buffer[offset] ?? 0) << 24) + ((buffer[offset + 1] ?? 0) << 16) + ((buffer[offset + 2] ?? 0) << 8) + (buffer[offset + 3] ?? 0);
  }

  async exportToDocx(emailData: EmailData, templatePath: string, exportFolder: string, signature?: SignatureData): Promise<string> {
    try {
      const emailDate = emailData.date ? new Date(emailData.date) : new Date();
      const formattedDate = emailDate.toLocaleDateString('ru-RU');

      const originalText = emailData.text || '';
      const emailImages: string[] = emailData.images || [];

      // Должность, учёная степень и учёное звание объединяются в одну строку
      // (через запятую, без переносов) — подставляется в {{Должность}}.
      const positionLine = [signature?.position, signature?.degree, signature?.rank]
        .map(v => (v || '').trim())
        .filter(Boolean)
        .join(', ');

      const data: TemplateData = {
        number: emailData.number || '',
        subject: emailData.subject || '',
        textForWord: this.formatTextForWord(originalText),
        author: emailData.author || 'И.И. Иванов',
        date: formattedDate,
        year: emailDate.getFullYear().toString(),
        month: (emailDate.getMonth() + 1).toString().padStart(2, '0'),
        day: emailDate.getDate().toString().padStart(2, '0'),
        time: emailDate.toLocaleTimeString('ru-RU'),
        position: positionLine,
        phone: (signature?.phone || '').trim(),
        email: (signature?.email || '').trim(),
      };

      let templateFound = false;
      let templateBuffer: ArrayBuffer | null = null;

      if (templatePath && templatePath.trim() !== '') {
        try {
          const adapter = this.app.vault.adapter;
          const exists = await adapter.exists(templatePath);

          if (exists && templatePath.toLowerCase().endsWith('.docx')) {
            templateBuffer = await adapter.readBinary(templatePath);
            templateFound = true;
          }
        } catch {
          // template not available
        }
      }

      let resultBuffer: ArrayBuffer;

      if (templateFound && templateBuffer) {
        try {
          const zip = await JSZip.loadAsync(templateBuffer);
          const documentFile = zip.file('word/document.xml');

          if (documentFile) {
            let xmlContent = await documentFile.async('text');

            // Текстовые плейсхолдеры. Word часто разбивает один плейсхолдер на
            // несколько <w:r>/<w:t> (например "{{Должность}}" = "{{"+"Должность"+}}"),
            // поэтому подстановка делается на уровне runs, а не по всей строке XML.
            const textReplacements: Record<string, string> = {
              '{{Номер}}': this.escapeXml(data.number),
              '{{Тема}}': this.escapeXml(data.subject),
              '{{Автор}}': this.escapeXml(data.author),
              '{{Дата}}': this.escapeXml(data.date),
              '{{Год}}': this.escapeXml(data.year),
              '{{Месяц}}': this.escapeXml(data.month),
              '{{День}}': this.escapeXml(data.day),
              '{{Время}}': this.escapeXml(data.time),
              '{{Должность}}': this.escapeXml(data.position),
              '{{Телефон}}': this.escapeXml(data.phone),
              '{{Почта}}': this.escapeXml(data.email),
            };
            xmlContent = this.replacePlaceholdersAcrossRuns(xmlContent, textReplacements);

            // {{Текст}} — блочная вставка абзацев (в шаблоне лежит целиком в одном
            // <w:t>), заменяется отдельно вместе с разметкой <w:p>.
            xmlContent = xmlContent.replace(/\{\{Текст\}\}/g, this.formatTextForDocxXml(originalText));

            zip.file('word/document.xml', xmlContent);
            resultBuffer = await zip.generateAsync({ type: 'arraybuffer' });
          } else {
            throw new Error('Не найден word/document.xml в шаблоне');
          }
        } catch {
          resultBuffer = await this.createFallbackDocx(data, emailImages);
        }
      } else {
        resultBuffer = await this.createFallbackDocx(data, emailImages);
      }

      const safeNumber = this.sanitizeFileName(data.number || 'без_номера');
      const safeSubject = this.sanitizeFileName((data.subject || 'Без темы').substring(0, 30));
      const fileName = `Письмо_${safeNumber}_${safeSubject}.docx`;

      const folderPath = exportFolder || 'Экспорт писем';
      const adapter = this.app.vault.adapter;

      if (!await adapter.exists(folderPath)) {
        await this.app.vault.createFolder(folderPath);
      }

      // Путь стабилен для одного письма (не плодим _1, _2, ... при повторном
      // экспорте) — файл перезаписывается. Word/системное приложение при повторном
      // открытии того же пути активирует уже открытый документ, а не заводит новый.
      const filePath = `${folderPath}/${fileName}`;

      const uint8Array = new Uint8Array(resultBuffer);
      await adapter.writeBinary(filePath, uint8Array.buffer as ArrayBuffer);

      // .docx не имеет встроенного просмотрщика в Obsidian — открывается системным
      // приложением (как в sbe-documents: openLocalFile для не-Obsidian-типов).
      if (adapter instanceof FileSystemAdapter) {
        const fullPath = adapter.getFullPath(filePath);
        const { shell } = require('electron');
        const openErr = await shell.openPath(fullPath);
        if (openErr) {
          new Notice(`Не удалось открыть Word: ${openErr}`);
        }
      } else {
        new Notice(`Файл сохранён: ${filePath}`);
      }

      new Notice(`✅ Экспорт завершён: ${fileName}${templateFound ? ' (с шаблоном)' : ' (стандартный)'}`);
      return filePath;

    } catch (error: unknown) {
      console.error('Письма: ошибка экспорта:', error);
      new Notice(`❌ Ошибка экспорта: ${errorMessage(error)}`);
      throw error;
    }
  }

  private async createFallbackDocx(data: TemplateData, images: string[]): Promise<ArrayBuffer> {
    const adapter = this.app.vault.adapter;
    const paragraphs: Paragraph[] = [];

    paragraphs.push(new Paragraph({
      alignment: 'center',
      children: [new TextRun({ text: 'ТЕХНИЧЕСКОЕ ПИСЬМО', bold: true, size: 28 })],
    }));
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: `№: ${data.number}` })] }));
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: `Дата: ${data.date}` })] }));
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: `Тема: ${data.subject}` })] }));
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: '─────────────────────────────────────────────────────' })] }));

    const imgRegex = /\{IMG_(\d+)\}/g;

    const lines = (data.textForWord || '').split('\n');
    for (const line of lines) {
      if (line.trim() === '') {
        paragraphs.push(new Paragraph({ children: [] }));
        continue;
      }

      imgRegex.lastIndex = 0;
      let match = imgRegex.exec(line);
      if (!match) {
        paragraphs.push(new Paragraph({ children: [new TextRun({ text: line })] }));
        continue;
      }

      const children: (TextRun | ImageRun)[] = [];
      let lastIndex = 0;
      imgRegex.lastIndex = 0;

      while ((match = imgRegex.exec(line)) !== null) {
        const textBefore = line.substring(lastIndex, match.index);
        if (textBefore) {
          children.push(new TextRun({ text: textBefore }));
        }

        const idx = parseInt(match[1]) - 1;
        if (idx >= 0 && idx < images.length) {
          try {
            const imgPath = images[idx];
            const imgBuffer = await adapter.readBinary(imgPath);
            const size = await this.getImageSize(imgPath);
            const maxWidth = 550;
            const scale = Math.min(1, maxWidth / (size.width || 1));
            const imgWidth = Math.round(size.width * scale);
            const imgHeight = Math.round(size.height * scale);

            children.push(new ImageRun({
              data: new Uint8Array(imgBuffer),
              transformation: { width: Math.max(imgWidth, 50), height: Math.max(imgHeight, 50) },
              type: imgPath.toLowerCase().endsWith('.png') ? 'png' : 'jpg',
            }));
          } catch (e: unknown) {
            console.warn('Письма: ошибка вставки изображения:', e);
            children.push(new TextRun({ text: `[Ошибка загрузки изображения ${match[1]}]` }));
          }
        } else {
          children.push(new TextRun({ text: match[0] }));
        }

        lastIndex = match.index + match[0].length;
      }

      const textAfter = line.substring(lastIndex);
      if (textAfter) {
        children.push(new TextRun({ text: textAfter }));
      }

      paragraphs.push(new Paragraph({ children }));
    }

    paragraphs.push(new Paragraph({ children: [new TextRun({ text: '─────────────────────────────────────────────────────' })] }));
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: 'С уважением,' })] }));
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: data.author })] }));
    if (data.position) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: data.position })] }));
    }
    if (data.phone) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: `Тел. ${data.phone}` })] }));
    }
    if (data.email) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: `e-mail: ${data.email}` })] }));
    }

    const doc = new Document({
      styles: { default: { document: { run: { size: 24 } } } },
      sections: [{ children: paragraphs }],
    });

    const buf = await Packer.toBuffer(doc);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}