import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
  Presentation,
} from 'lucide-react';

const EXTENSION_ICONS: Array<[RegExp, LucideIcon]> = [
  [/\.(?:zip|rar|7z|tar|gz|tgz|bz2|xz)$/i, FileArchive],
  [/\.(?:xlsx?|csv|numbers|ods)$/i, FileSpreadsheet],
  [/\.(?:pptx?|key|odp)$/i, Presentation],
  [/\.(?:pdf|docx?|odt|rtf|txt|md|pages)$/i, FileText],
  [/\.(?:json|xml|html?|js|ts|py|go|java|c|cpp|sh|ya?ml|toml)$/i, FileCode],
];

/** 按 MIME 类型（其次扩展名）选附件图标 */
export function attachmentIcon(mimeType: string, filename: string): LucideIcon {
  const type = mimeType.toLowerCase();
  if (type.startsWith('image/')) return FileImage;
  if (type.startsWith('video/')) return FileVideo;
  if (type.startsWith('audio/')) return FileAudio;
  if (type.includes('spreadsheet') || type.includes('excel') || type === 'text/csv') return FileSpreadsheet;
  if (type.includes('presentation') || type.includes('powerpoint')) return Presentation;
  if (/zip|compressed|x-tar|x-7z|x-rar|gzip/.test(type)) return FileArchive;
  if (type === 'application/pdf' || type.includes('word') || type.startsWith('text/')) {
    return /\.(?:html?|json|xml)$/i.test(filename) ? FileCode : FileText;
  }
  return EXTENSION_ICONS.find(([pattern]) => pattern.test(filename))?.[1] ?? File;
}
