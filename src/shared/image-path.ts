import path from 'node:path';

// Formats accepted by Feishu's image upload API.
const IMAGE_FILE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff']);

export function isSupportedImagePath(filePath: string): boolean {
  return IMAGE_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
